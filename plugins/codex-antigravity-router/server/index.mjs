import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { availableModels, cancelTask, dashboardAgents, delegate, disposeTask, integrateTask, recover, requestStopAllWorkers, status, waitForBatchChange } from './orchestrator.mjs';
import { MAX_WORKERS_LIMIT, readUserSettings, validatePreferredModel, writeUserSettings } from './settings.mjs';
import { openBrowserDashboard } from './dashboard-web.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const DASHBOARD_URI = 'ui://antigravity-router/dashboard-v0.7.1.html';
const DASHBOARD_HTML = fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
export function delegationDefaults(env = process.env) {
  const settings = readUserSettings({ env });
  const runMode = env.CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE === 'trusted-local' ? 'trusted-local' : 'fail-closed';
  return { runMode, model: settings.model, maxWorkers: settings.maxWorkers, maxParallel: settings.maxWorkers, settingsFile: settings.settingsFile };
}
export function resolveDelegationOptions(args, defaults = delegationDefaults()) {
  if (args.executionMode !== undefined && !['sequential', 'parallel'].includes(args.executionMode)) {
    throw new Error('executionMode must be sequential or parallel.');
  }
  if (args.runMode !== undefined && !['fail-closed', 'trusted-local'].includes(args.runMode)) {
    throw new Error('runMode must be fail-closed or trusted-local.');
  }
  if (args.runMode === 'trusted-local' && defaults.runMode !== 'trusted-local') {
    throw new Error('Trusted-local verification requires the operator to set CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE=trusted-local before launching Codex.');
  }
  if (args.maxParallel !== undefined && (!Number.isSafeInteger(args.maxParallel) || args.maxParallel < 1 || args.maxParallel > defaults.maxWorkers)) {
    throw new Error(`maxParallel must be an integer from 1 to the configured maximum of ${defaults.maxWorkers}.`);
  }
  const maxParallel = args.executionMode === 'sequential' ? 1 : args.maxParallel ?? Math.min(defaults.maxWorkers, args.tasks?.length || 1);
  // The dashboard preference is authoritative. Task payloads cannot silently
  // substitute a different provider/model; users change it in the dashboard.
  return { ...args, model: defaults.model, runMode: args.runMode ?? defaults.runMode, maxParallel };
}
const task = { type: 'object', properties: {
  id: { type: 'string', description: 'Unique batch-local identifier: letters, digits, underscore or hyphen.' },
  title: { type: 'string' },
  risk: { type: 'string', enum: ['LOW_RISK', 'HIGH_RISK', 'low'] },
  context: { type: 'string', description: 'Only decision-relevant context and references.' },
  instructions: { type: 'string', description: 'Coherent engineering outcome and constraints.' },
  allowedPaths: { type: 'array', items: { type: 'string' }, description: 'Bounded relative file paths or patterns. Exact paths permit concurrent editing.' },
  contextPaths: { type: 'array', items: { type: 'string' }, description: 'Untracked files or directories needed for read-only context. Changes outside allowedPaths are rejected.' },
  acceptanceCriteria: { type: 'array', items: { type: 'string' } },
  dependsOn: { type: 'array', items: { type: 'string' }, description: 'Earlier task IDs; ready tasks execute FIFO.' },
  parallelSafe: { type: 'boolean', description: 'Legacy caller hint; actual isolation and conflict checks are enforced by the controller.' },
  verificationCommands: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Independent executable and arguments, run by the controller in the worker tree.' }
}, required: ['id', 'title', 'risk', 'instructions', 'allowedPaths', 'acceptanceCriteria'], additionalProperties: false };
const tools = [
  { name: 'antigravity_dashboard', description: 'Start or reopen the Antigravity Router dashboard in a local browser and return its private loopback link.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'antigravity_dashboard_data', description: 'Read router settings and concise current worker state for the dashboard.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'antigravity_update_settings', description: 'Save delegation enabled state, model preference, and worker ceiling from the router dashboard.', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, maxWorkers: { type: 'integer', minimum: 1, maximum: MAX_WORKERS_LIMIT }, model: { type: 'string' } }, required: ['enabled', 'maxWorkers', 'model'], additionalProperties: false } },
  { name: 'antigravity_status', description: 'Check the local CLI, model, and Git workspace.', inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, model: { type: 'string' } }, required: ['workspaceRoot'], additionalProperties: false } },
  { name: 'delegate_antigravity_tasks', description: 'Submit up to the user-configured Antigravity worker limit (1–32). Codex chooses a lower maxParallel for dependent or overlapping work. The controller runs every supplied verification check in order. Trusted-local commands use normal Windows user permissions when configured.', inputSchema: { type: 'object', properties: {
    workspaceRoot: { type: 'string' }, model: { type: 'string' }, runMode: { type: 'string', enum: ['fail-closed', 'trusted-local'] }, executionMode: { type: 'string', enum: ['sequential', 'parallel'] }, maxParallel: { type: 'integer', minimum: 1, maximum: MAX_WORKERS_LIMIT }, timeoutSeconds: { type: 'integer', minimum: 60, maximum: 3600 }, waitSeconds: { type: 'integer', minimum: 0, maximum: 30, description: 'Maximum time to wait for this response; the durable batch ID is returned even if work continues.' },
    tasks: { type: 'array', minItems: 1, maxItems: 32, items: task }
  }, required: ['workspaceRoot', 'tasks'], additionalProperties: false } },
  { name: 'antigravity_recover', description: 'Inspect a preserved batch; optionally mark interrupted work for review and resume queued tasks without rerunning uncertain work.', inputSchema: { type: 'object', properties: {
    workspaceRoot: { type: 'string' }, batchId: { type: 'string' }, resumeQueued: { type: 'boolean' }
  }, required: ['workspaceRoot', 'batchId'], additionalProperties: false } },
  { name: 'antigravity_wait', description: 'Wait up to 30 seconds for a durable batch state change after a cursor, then return its full batch ID, updated cursor, and task states.', inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, batchId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 }, waitSeconds: { type: 'integer', minimum: 0, maximum: 30 } }, required: ['workspaceRoot', 'batchId', 'cursor'], additionalProperties: false } },
  { name: 'antigravity_integrate', description: 'Integrate one verified task held for HIGH_RISK or missing behavioral checks after Codex decides whether direct inspection is needed. Conflicts preserve the worker.', inputSchema: { type: 'object', properties: {
    workspaceRoot: { type: 'string' }, batchId: { type: 'string' }, taskId: { type: 'string' }
  }, required: ['workspaceRoot', 'batchId', 'taskId'], additionalProperties: false } },
  { name: 'antigravity_cancel', description: 'Request cancellation of a queued or active task while preserving its worktree and state.', inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, batchId: { type: 'string' }, taskId: { type: 'string' } }, required: ['workspaceRoot', 'batchId', 'taskId'], additionalProperties: false } }
  ,{ name: 'antigravity_dispose', description: 'Remove a completed or cancelled worker worktree only after confirming every worker change is preserved in the authoritative workspace.', inputSchema: { type: 'object', properties: { workspaceRoot: { type: 'string' }, batchId: { type: 'string' }, taskId: { type: 'string' } }, required: ['workspaceRoot', 'batchId', 'taskId'], additionalProperties: false } }
];
const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });
async function call(name, args) {
  if (name === 'antigravity_dashboard') {
    const dashboard = await openBrowserDashboard();
    return result({ ...dashboard, serverStarted: dashboard.listening, message: 'Open the private link in the in-app browser. If it cannot reach the dashboard, open the same link in Edge or Chrome on this computer. Request a fresh link if the router has restarted.' });
  }
  if (name === 'antigravity_dashboard_data') return result({ settings: readUserSettings(), models: await availableModels(), agents: dashboardAgents() });
  if (name === 'antigravity_update_settings') {
    const model = validatePreferredModel(args.model, 'model');
    if (!Number.isSafeInteger(args.maxWorkers) || args.maxWorkers < 1 || args.maxWorkers > MAX_WORKERS_LIMIT || typeof args.enabled !== 'boolean') throw new Error('Invalid dashboard settings.');
    const saved = writeUserSettings({ enabled: args.enabled, maxWorkers: args.maxWorkers, model });
    const stoppedWorkers = args.enabled ? 0 : requestStopAllWorkers('Delegation disabled in the router dashboard.');
    return result({ ...saved, stoppedWorkers, message: args.enabled ? 'Settings saved.' : `Delegation disabled; cancellation requested for ${stoppedWorkers} active worker(s).` });
  }
  if (typeof args.workspaceRoot !== 'string' || !path.isAbsolute(args.workspaceRoot)) throw new Error('workspaceRoot must be absolute.');
  if (name === 'antigravity_status') return result(await status(args.workspaceRoot, args.model));
  if (name === 'delegate_antigravity_tasks') {
    if (args.timeoutSeconds !== undefined && (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 60 || args.timeoutSeconds > 3600)) throw new Error('timeoutSeconds must be 60–3600.');
    const defaults = delegationDefaults();
    const options = resolveDelegationOptions({ waitSeconds: 0, ...args }, defaults);
    const out = await delegate(args.workspaceRoot, args.tasks, options);
    return result(out, out.results.some((item) => ['needs_review', 'conflict'].includes(item.status)));
  }
  if (name === 'antigravity_recover') {
    if (!/^[0-9a-f-]{36}$/i.test(args.batchId)) throw new Error('Invalid batch ID.');
    return result(await recover(args.workspaceRoot, args.batchId, args.resumeQueued === true));
  }
  if (name === 'antigravity_wait') return result(await waitForBatchChange(args.workspaceRoot, args.batchId, args.cursor, args.waitSeconds ?? 20));
  if (name === 'antigravity_integrate') return result(await integrateTask(args.workspaceRoot, args.batchId, args.taskId));
  if (name === 'antigravity_cancel') return result(cancelTask(args.workspaceRoot, args.batchId, args.taskId));
  if (name === 'antigravity_dispose') return result(await disposeTask(args.workspaceRoot, args.batchId, args.taskId));
  throw new Error(`Unknown tool: ${name}`);
}
function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
async function handle(message) {
  if (message.id === undefined) return;
  try {
    let value;
    switch (message.method) {
      case 'initialize': value = { protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'codex-antigravity-router', version: '1.0.3' } }; break;
      case 'ping': value = {}; break;
      case 'tools/list': value = { tools }; break;
      case 'resources/list': value = { resources: [{ uri: DASHBOARD_URI, name: 'Antigravity Router Dashboard', mimeType: 'text/html;profile=mcp-app' }] }; break;
      case 'resources/read': if (message.params?.uri !== DASHBOARD_URI) throw new Error('Unknown UI resource.'); value = { contents: [{ uri: DASHBOARD_URI, mimeType: 'text/html;profile=mcp-app', text: DASHBOARD_HTML }] }; break;
      case 'tools/call': value = await call(message.params?.name, message.params?.arguments || {}); break;
      default: write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return;
    }
    write({ jsonrpc: '2.0', id: message.id, result: value });
  } catch (e) { write({ jsonrpc: '2.0', id: message.id, result: result({ error: e.message }, true) }); }
}
export async function serve(input = process.stdin) {
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) if (line.trim()) {
    try { void handle(JSON.parse(line)); } catch (e) { process.stderr.write(`Invalid MCP message: ${e.message}\n`); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serve();
