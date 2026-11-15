import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquire, canonical, changed, createWorker, disposeWorker, git, globalRoot, hash, integrate, key, load, managedCheckout, persist, safeFile, snapshot, stateRoot } from './worktrees.mjs';
import { configuredExecutionProvider, requireAuthorizedProvider } from './execution-provider.mjs';
import { MAX_WORKERS_LIMIT, readUserSettings, validatePreferredModel, writeUserSettings } from './settings.mjs';

const exec = promisify(execFile);
const CLI = process.env.CODEX_ANTIGRAVITY_CLI || path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
const now = () => new Date().toISOString();
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const normalize = (p) => key(path.resolve(p));
let batchQueue = Promise.resolve();
let queuedBatchCount = 0;
const activeWorkerPids = new Set();
const scheduledBatches = new Set();
let integrationQueue = Promise.resolve();
function enqueueBatch(batchId, run) {
  queuedBatchCount++;
  const position = queuedBatchCount;
  scheduledBatches.add(batchId);
  const completion = batchQueue.then(async () => { queuedBatchCount--; return run(); }).finally(() => scheduledBatches.delete(batchId));
  batchQueue = completion.catch(() => {});
  return { completion, position };
}
async function integrateWithControllerLock(root, worker, snap, files) {
  let unlock;
  const previous = integrationQueue;
  integrationQueue = new Promise((resolve) => { unlock = resolve; });
  await previous;
  try {
    const release = acquire(globalRoot());
    try { return await integrate(root, worker, snap, files); }
    finally { release(); }
  } finally { unlock(); }
}
function liveUnownedWorkers() {
  const base = globalRoot();
  if (!fs.existsSync(base)) return [];
  const found = [];
  for (const repo of fs.readdirSync(base, { withFileTypes: true })) if (repo.isDirectory())
    for (const batch of fs.readdirSync(path.join(base, repo.name), { withFileTypes: true })) if (batch.isDirectory()) {
      const file = path.join(base, repo.name, batch.name, 'state.json');
      if (!fs.existsSync(file)) continue;
      const state = load(file);
      for (const t of state.tasks || []) if (alive(t.pid) && !activeWorkerPids.has(t.pid)) found.push({ batchId: state.batchId, taskId: t.id, pid: t.pid });
    }
  return found;
}

export async function status(root, model) {
  let settings;
  try { settings = readUserSettings(); }
  catch (e) { return { ready: false, message: `Invalid Antigravity router settings: ${e.message}` }; }
  const selectedModel = model || settings.model;
  if (!path.isAbsolute(root) || !fs.existsSync(root)) return { ready: false, model: selectedModel, preferredModel: settings.model, maxWorkers: settings.maxWorkers, settingsFile: settings.settingsFile, message: 'Choose an existing absolute workspace.' };
  try {
    const gitRoot = (await git(root, 'rev-parse', '--show-toplevel')).trim();
    if (normalize(canonical(gitRoot)) !== normalize(canonical(root))) throw new Error('Workspace must be the repository root.');
    const { stdout } = await exec(CLI, ['models'], { cwd: root, windowsHide: true, timeout: 20000 });
    const models = stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    if (!models.includes(selectedModel)) return { ready: false, model: selectedModel, preferredModel: settings.model, maxWorkers: settings.maxWorkers, settingsFile: settings.settingsFile, availableModels: models, message: 'Selected model is unavailable.' };
    return { ready: true, model: selectedModel, preferredModel: settings.model, availableModels: models, transport: 'agy-cli-sandbox-worktree', maxWorkers: settings.maxWorkers, settingsFile: settings.settingsFile, restrictedVerification: false, restrictedVerificationReason: 'No verified OS-level execution provider is configured.' };
  } catch (e) { return { ready: false, model: selectedModel, preferredModel: settings.model, maxWorkers: settings.maxWorkers, settingsFile: settings.settingsFile, message: e.message }; }
}

function allowed(patterns) {
  if (!Array.isArray(patterns) || !patterns.length || patterns.length > 30) throw new Error('Each task needs 1–30 allowed paths.');
  return patterns.map((p) => {
    if (typeof p !== 'string' || !p.trim() || path.isAbsolute(p) || p.split(/[\\/]/).includes('..') || p === '.' || p === '**') throw new Error(`Invalid allowed path: ${p}`);
    return p.replaceAll('\\', '/');
  });
}
function matches(file, patterns) {
  return patterns.some((p) => {
    let x = '^';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*' && p[i + 1] === '*' && p[i + 2] === '/') { x += '(?:.*/)?'; i += 2; }
      else if (c === '*' && p[i + 1] === '*') { x += '.*'; i++; }
      else if (c === '*') x += '[^/]*';
      else if (c === '?') x += '[^/]';
      else x += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`${x}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '').test(file);
  });
}
function validate(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 32) throw new Error('Submit 1–32 tasks.');
  const seen = new Set();
  return tasks.map((t, i) => {
    if (!t || typeof t.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.id) || seen.has(t.id)) throw new Error(`Task ${i + 1} has a missing, duplicate, or unsafe ID.`);
    seen.add(t.id);
    if (!['LOW_RISK', 'HIGH_RISK', 'low'].includes(t.risk)) throw new Error(`Task ${t.id} needs LOW_RISK or HIGH_RISK.`);
    if (typeof t.title !== 'string' || !t.title.trim() || typeof t.instructions !== 'string' || !t.instructions.trim()) throw new Error(`Task ${t.id} needs title and instructions.`);
    if (!Array.isArray(t.acceptanceCriteria) || !t.acceptanceCriteria.length) throw new Error(`Task ${t.id} needs acceptance criteria.`);
    if (t.dependsOn && (!Array.isArray(t.dependsOn) || t.dependsOn.some((d) => !seen.has(d)))) throw new Error(`Task ${t.id} has an unknown or forward dependency.`);
    const commands = t.verificationCommands || [];
    if (!Array.isArray(commands) || commands.some((c) => !Array.isArray(c) || !c.length || c.some((v) => typeof v !== 'string'))) throw new Error(`Task ${t.id} has invalid verification commands.`);
    return { ...t, risk: t.risk === 'low' ? 'LOW_RISK' : t.risk, allowedPaths: allowed(t.allowedPaths), dependsOn: t.dependsOn || [], verificationCommands: commands, status: 'queued', createdAt: now() };
  });
}
function overlaps(a, b) {
  if (a.allowedPaths.some((p) => /[?*]/.test(p)) || b.allowedPaths.some((p) => /[?*]/.test(p))) return true;
  return a.allowedPaths.some((p) => b.allowedPaths.some((q) => {
    const x = p.toLowerCase(), y = q.toLowerCase();
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}
export function buildAgentPrompt(worker, t, retry = '') {
  return [
    `Task: ${t.title} [${t.risk}]`,
    `Work only in the isolated Git worktree at ${worker}. The original checkout is authoritative; do not access it.`,
    `Follow AGENTS.md. ${t.context || ''}`,
    t.instructions,
    `Allowed edits: ${t.allowedPaths.join(', ')}.`,
    `Acceptance: ${t.acceptanceCriteria.join('; ')}.`,
    t.verificationCommands.length ? `Mandatory controller checks (all run in listed order): ${t.verificationCommands.map((c, i) => `${i}: ${c[0]} (${c.length - 1} arguments)`).join('; ')}. Do not call terminal, command, notebook, or code-execution tools. The controller runs every supplied check in the assigned worktree and returns bounded stdout/stderr, exit status, timeout and duration for each failure. Diagnose failures and repair the implementation.` : 'No controller check is authorized. Do not call terminal, command, notebook, or code-execution tools; report what verification is needed.',
    'Investigate root cause, implement the complete fix, and check it. Repair ordinary failures autonomously. No commit, push, destructive reset, external write, or further delegation. Preserve work. If consequential risk or out-of-scope edits are needed, stop and begin the final reply with ESCALATE_RISK: followed by the reason. Report concise changes, checks, uncertainty, and blockers.',
    retry ? `Independent verification failed: ${retry}. Diagnose and repair within the same worktree, then report the result.` : ''
  ].filter(Boolean).join('\n');
}
function runCli(worker, t, model, timeout, retry, onPid, cancelFile) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const settings = JSON.stringify({ permissions: { allow: [`read_file(${worker})`, `write_file(${worker})`] } });
    const brief = buildAgentPrompt(worker, t, retry);
    const args = ['--sandbox', '--settings', settings, '--output-format', 'stream-json', '--mode', 'accept-edits', '--model', model, '--print-timeout', `${timeout}s`, '--print', brief];
    const child = spawn(CLI, args, { cwd: worker, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onPid(child.pid);
    let buffer = '', stderr = '', result = null, observedCwd = null, denied = [], tools = [], timedOut = false, cancelled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout * 1000 + 15000);
    const cancellation = setInterval(() => { if (fs.existsSync(cancelFile) && !cancelled) { cancelled = true; child.kill(); if (process.platform === 'win32' && child.pid) exec('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).catch(() => {}); } }, 250);
    const line = (s) => { try { const e = JSON.parse(s); if (e.event === 'init') observedCwd = e.init?.cwd || null; if (e.event === 'result') { result = e.result; denied = result?.denied_actions || []; } if (e.event === 'step_update' && e.step_update?.step_type === 'tool') tools.push({ name: e.step_update.tool_info?.name, state: e.step_update.state }); } catch {} };
    child.stdout.on('data', (c) => { buffer += c; let n; while ((n = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, n)); buffer = buffer.slice(n + 1); } if (buffer.length > 4000000) buffer = ''; });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-3000); });
    child.on('error', (e) => { stderr = e.message; });
    child.on('close', (code) => { clearTimeout(timer); clearInterval(cancellation); line(buffer); resolve({ code, timedOut, cancelled, result, observedCwd, denied, tools, stderr, briefCharacters: brief.length, durationMs: Date.now() - startedAt }); });
  });
}
export function quotaExhaustionReason(run) {
  const text = [run?.stderr, run?.result?.response, run?.result?.message, run?.result?.error, run?.result?.status].filter(Boolean).join('\n');
  if (/\b(resource_exhausted|quota[_ -]?(?:exceeded|exhausted|limit)|rate[_ -]?limit(?:ed)?|too many requests|weekly quota|usage limit reached|model quota)\b|\b429\b/i.test(text)) return text.replace(/\s+/g, ' ').slice(0, 700) || 'Antigravity reported a quota limit.';
  return null;
}
export function dashboardAgents() {
  const base = globalRoot(); if (!fs.existsSync(base)) return [];
  const active = new Set(['starting', 'preparing', 'running', 'retrying']);
  const recent = new Set(['completed', 'quota_exhausted', 'needs_review', 'awaiting_integration', 'cancelled', 'conflict']); const rows = [];
  const timestamp = (value) => {
    if (typeof value !== 'string') return NaN;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    // PowerShell-generated fixtures and older persisted batches may use dd-MM-yyyy HH:mm:ss.
    const match = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
    return match ? Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) : NaN;
  };
  for (const repo of fs.readdirSync(base, { withFileTypes: true })) if (repo.isDirectory())
    for (const batch of fs.readdirSync(path.join(base, repo.name), { withFileTypes: true })) if (batch.isDirectory()) {
      const file = path.join(base, repo.name, batch.name, 'state.json'); if (!fs.existsSync(file)) continue;
      try { const state = load(file); for (const task of state.tasks || []) { const live = active.has(task.status) && alive(task.pid); const completedAt = timestamp(task.finishedAt || task.createdAt); const recentDone = recent.has(task.status) && Number.isFinite(completedAt) && Date.now() - completedAt >= 0 && Date.now() - completedAt < 600000; if (live || recentDone) rows.push({ name: `Worker ${task.id}`, task: String(task.title || task.id).slice(0, 100), phase: task.status, live, workspace: path.basename(state.root), model: state.model || 'unknown', startedAt: task.startedAt || null }); } } catch {}
    }
  return rows.slice(0, MAX_WORKERS_LIMIT);
}
export function requestStopAllWorkers(reason = 'delegation disabled') {
  const base = globalRoot(); if (!fs.existsSync(base)) return 0; let stopped = 0;
  for (const repo of fs.readdirSync(base, { withFileTypes: true })) if (repo.isDirectory())
    for (const batch of fs.readdirSync(path.join(base, repo.name), { withFileTypes: true })) if (batch.isDirectory()) {
      const folder = path.join(base, repo.name, batch.name), file = path.join(folder, 'state.json'); if (!fs.existsSync(file)) continue;
      try { const state = load(file); for (const task of state.tasks || []) if (['starting', 'preparing', 'running', 'retrying'].includes(task.status)) { fs.writeFileSync(path.join(folder, `${task.id}.cancel`), reason); stopped++; } } catch {}
    }
  return stopped;
}
let modelCache = { at: 0, values: [] };
export async function availableModels() {
  if (Date.now() - modelCache.at < 300000 && modelCache.values.length) return modelCache.values;
  try { const { stdout } = await exec(CLI, ['models'], { cwd: os.homedir(), windowsHide: true, timeout: 20000 }); modelCache = { at: Date.now(), values: stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter((model) => /^[a-zA-Z0-9._-]+$/.test(model)) }; return modelCache.values; }
  catch { return modelCache.values; }
}
function stopBatchForQuota(folder, state, currentTask, reason, save) {
  let preferenceWriteError = null;
  try { writeUserSettings({ enabled: false }); } catch (error) { preferenceWriteError = error.message; }
  state.autoDisabled = true;
  state.autoDisabledReason = 'Antigravity quota limit detected';
  state.autoDisabledAt = now();
  state.autoDisabledPersisted = !preferenceWriteError;
  if (preferenceWriteError) state.autoDisableError = preferenceWriteError;
  for (const task of state.tasks) {
    if (task === currentTask) continue;
    if (['queued', 'starting', 'preparing', 'running', 'retrying'].includes(task.status)) {
      try { fs.writeFileSync(path.join(folder, `${task.id}.cancel`), 'quota limit detected'); } catch {}
      if (task.status === 'queued') { task.status = 'quota_blocked'; task.error = 'Stopped because an Antigravity quota limit disabled delegation.'; }
    }
  }
  currentTask.status = 'quota_exhausted';
  currentTask.error = `Antigravity quota limit detected; delegation was ${preferenceWriteError ? 'disabled for this batch, but could not be saved in settings' : 'turned off'}. ${reason}`;
  save();
}
async function verify(worker, t, timeout, provider) {
  const checks = [];
  for (const command of t.verificationCommands) {
    try {
      const result = await provider.run({ taskId: t.id, workspace: worker, command, timeoutSeconds: Math.min(timeout, 300) });
      if (result?.workspace !== worker || !Number.isInteger(result?.exitCode)) throw new Error('Restricted runner returned an invalid workspace or exit status.');
      checks.push({ command, label: `${command[0]} (${command.length - 1} args)`, passed: result.exitCode === 0, exitCode: result.exitCode, timedOut: result.timedOut === true, durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null, stdoutTail: String(result.stdoutTail ?? result.output ?? '').slice(-2000), stderrTail: String(result.stderrTail || '').slice(-2000) });
    } catch (e) { checks.push({ command, label: `${command[0]} (${command.length - 1} args)`, passed: false, exitCode: null, timedOut: false, durationMs: null, stdoutTail: '', stderrTail: String(e.message || e).slice(-2000) }); }
  }
  return checks;
}
async function execute(root, folder, state, t, model, timeout, save, provider, workerRunner, getSnapshot) {
  t.status = 'preparing'; save();
  const cancelFile = path.join(folder, `${t.id}.cancel`);
  const worker = await managedCheckout(root, state.batchId, state.tasks.indexOf(t));
  t.worker = worker; save();
  const prepared = await getSnapshot(t);
  const { snap, snapshotFile } = prepared;
  t.snapshotDurationMs = prepared.createdForTask === t.id ? prepared.durationMs : 0;
  t.snapshotFile = snapshotFile; save();
  await createWorker(root, folder, t.id, snap, worker);
  if (fs.existsSync(cancelFile)) { t.status = 'cancelled'; save(); return; }
  t.status = 'running'; t.startedAt = now(); save();
  let reply = '', run, edits = [], checks = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    t.attempts = attempt + 1; save();
    const retry = attempt ? t.verificationFailure : '';
    const attemptStartedAt = Date.now();
    const trackPid = (pid) => { if (pid) activeWorkerPids.add(pid); t.pid = pid; save(); };
    try { run = await (workerRunner ? workerRunner({ worker, task: t, model, timeout, retry, onPid: trackPid, cancelFile }) : runCli(worker, t, model, timeout, retry, trackPid, cancelFile)); }
    finally { if (t.pid) activeWorkerPids.delete(t.pid); }
    t.briefCharacters = (t.briefCharacters || 0) + run.briefCharacters;
    t.workerDurationMs = (t.workerDurationMs || 0) + (Number.isFinite(run.durationMs) ? run.durationMs : Date.now() - attemptStartedAt);
    t.toolEvents = (t.toolEvents || 0) + (Array.isArray(run.tools) ? run.tools.length : 0);
    t.antigravityTokens = (t.antigravityTokens || 0) + (run.result?.usage?.total_tokens || 0);
    t.pid = null; t.conversationId = run.result?.conversation_id || t.conversationId; save();
    if (run.cancelled || fs.existsSync(cancelFile)) { t.status = 'cancelled'; break; }
    const rawReply = String(run.result?.response || '');
    t.responseCharacters = (t.responseCharacters || 0) + rawReply.length;
    reply = rawReply.slice(0, 1800);
    edits = await changed(worker, snap);
    if (run.timedOut && edits.length === 0) t.zeroEditTimeouts = (t.zeroEditTimeouts || 0) + 1;
    const quota = quotaExhaustionReason(run);
    if (quota) {
      t.changedFiles = edits;
      t.outputHashes = Object.fromEntries(edits.map((p) => [p, hash(safeFile(worker, p))]));
      t.reply = reply; t.usage = run.result?.usage || null; t.finishedAt = now();
      stopBatchForQuota(folder, state, t, quota, save);
      return;
    }
    const scope = edits.filter((p) => !matches(p, t.allowedPaths));
    const cwdOk = run.observedCwd && normalize(run.observedCwd) === normalize(worker);
    const commandTools = run.tools.filter((x) => /run_command|send_command_input|notebook_execution/i.test(x.name || ''));
    if (run.timedOut || run.code !== 0 || run.result?.status !== 'SUCCESS' || !cwdOk || run.denied.length || scope.length || commandTools.length) {
      t.status = 'needs_review';
      const deniedDetails = run.denied.map((d) => {
        const item = typeof d === 'string' ? { action: d } : d || {};
        const scopePath = item.path || item.scope || item.target;
        const relativeScope = typeof scopePath === 'string' && path.isAbsolute(scopePath) ? (normalize(scopePath).startsWith(`${normalize(worker)}${path.sep}`) ? path.relative(worker, scopePath).replaceAll('\\', '/') : '[outside assigned worktree]') : String(scopePath || 'unspecified');
        return `${String(item.action || item.tool || 'unknown tool').slice(0, 80)}; rule=${String(item.rule || item.reason || 'not reported').slice(0, 120)}; scope=${relativeScope}; executed=${item.executed === true ? 'yes' : 'no/unknown'}`;
      });
      t.error = run.timedOut ? 'CLI timeout' : !cwdOk ? 'CLI did not prove assigned worktree CWD' : scope.length ? `Out-of-scope edits: ${scope.join(', ')}` : commandTools.length ? `Command side effects need review: ${commandTools.map((x) => `${x.name || 'command'} (${x.state || 'state unknown'})`).join(', ')}` : run.denied.length ? `CLI permission denials: ${deniedDetails.join(' | ')}` : run.stderr || `CLI status: ${run.result?.status || run.code}`;
      break;
    }
    if (/^\s*ESCALATE_RISK:/i.test(reply)) { t.status = 'needs_review'; t.error = 'Worker escalated risk or scope'; break; }
    if (!edits.length && !reply.trim()) { t.status = 'needs_review'; t.error = 'CLI returned empty result and no edits'; break; }
    const beforeChecks = Object.fromEntries(edits.map((p) => [p, hash(safeFile(worker, p))]));
    checks = await verify(worker, t, timeout, provider);
    const failed = checks.filter((c) => !c.passed);
    if (!failed.length) {
      if (edits.some((p) => hash(safeFile(worker, p)) !== beforeChecks[p])) { t.status = 'needs_review'; t.error = 'Verification command modified worker output.'; break; }
      t.status = 'verified'; break;
    }
    t.verificationFailure = failed.map((c) => JSON.stringify({ check: c.label, exitCode: c.exitCode, timedOut: c.timedOut, durationMs: c.durationMs, stdoutTail: c.stdoutTail.slice(-1200), stderrTail: c.stderrTail.slice(-1200) })).join('\n');
    t.status = attempt ? 'needs_review' : 'retrying'; save();
    if (attempt) t.error = 'Independent verification failed after autonomous repair';
  }
  const finalEdits = await changed(worker, snap);
  if (t.status === 'verified' && (finalEdits.length !== edits.length || finalEdits.some((p, i) => p !== edits[i]))) { t.status = 'needs_review'; t.error = 'Verification changed the worker file set; inspect before integration.'; }
  t.changedFiles = finalEdits; t.outputHashes = Object.fromEntries(finalEdits.map((p) => [p, hash(safeFile(worker, p))])); t.checks = checks; t.reply = reply; t.usage = run?.result?.usage || null; t.finishedAt = now(); save();
  if (t.status !== 'verified') return;
  if (fs.existsSync(cancelFile)) { t.status = 'cancelled'; save(); return; }
  if (!t.verificationCommands.length) { t.status = 'awaiting_integration'; t.error = 'No independent check was supplied; Codex must review before integration.'; save(); return; }
  if (t.risk === 'HIGH_RISK') { t.status = 'awaiting_integration'; save(); return; }
  t.status = 'integrating'; save();
  const result = await integrateWithControllerLock(root, worker, snap, edits);
  if (!result.integrated) { t.status = 'conflict'; t.conflicts = result.conflicts; }
  else { t.status = 'completed'; state.invalidateSnapshot?.(); }
  save();
}
function report(state) { return { batchId: state.batchId, cursor: state.revision || 0, workspaceRoot: state.root, stateFile: state.stateFile, model: state.model || null, maxWorkers: state.maxWorkers ?? null, maxParallel: state.maxParallel ?? null, batchStatus: state.batchStatus || null, snapshotPreparations: state.snapshotPreparations || 0, total: state.tasks.length, completed: state.tasks.filter((t) => t.status === 'completed').length, briefCharacters: state.tasks.reduce((n, t) => n + (t.briefCharacters || 0), 0), antigravityTokens: state.tasks.reduce((n, t) => n + (t.antigravityTokens || t.usage?.total_tokens || 0), 0), codexTokenUsage: null, telemetryNote: 'Codex per-call tokens are not exposed by this router; character, tool-event, repair, timeout, and duration values are proxies.', results: state.tasks.map((t) => ({ id: t.id, risk: t.risk, status: t.status, attempts: t.attempts, repairRounds: Math.max(0, (t.attempts || 0) - 1), briefCharacters: t.briefCharacters || 0, responseCharacters: t.responseCharacters || 0, workerDurationMs: t.workerDurationMs || 0, snapshotDurationMs: t.snapshotDurationMs || 0, toolEvents: t.toolEvents || 0, zeroEditTimeouts: t.zeroEditTimeouts || 0, changedFiles: t.changedFiles, checksPassed: t.checks?.filter((c) => c.passed).length || 0, checksFailed: t.checks?.filter((c) => !c.passed).length || 0, checks: (t.checks || []).map((c) => ({ label: c.label || 'verification check', passed: c.passed, exitCode: c.exitCode ?? null, timedOut: c.timedOut === true, durationMs: c.durationMs ?? null, stdoutTail: String(c.stdoutTail || '').slice(-1200), stderrTail: String(c.stderrTail || '').slice(-1200) })), summary: t.reply?.replace(/\[([^\]]+)\]\(file:\/\/\/[^)]+\)/g, '$1').replace(/\s+/g, ' ').slice(0, t.risk === 'HIGH_RISK' ? 600 : 240), ...(t.status !== 'completed' || t.risk === 'HIGH_RISK' ? { worker: t.worker, error: t.error, conflicts: t.conflicts } : {}) })) }; }
async function schedule(state, folder, model, timeout, provider, workerRunner) {
  const save = () => { state.revision = (state.revision || 0) + 1; state.updatedAt = now(); persist(state.stateFile, state); };
  let snapshotGeneration = 0, snapshotPromise = null, snapshotDurationMs = 0;
  const getSnapshot = async (task) => {
    if (!snapshotPromise) {
      const generation = snapshotGeneration;
      const startedAt = Date.now();
      snapshotPromise = snapshot(state.root).then((snap) => {
        const durationMs = Date.now() - startedAt;
        snapshotDurationMs += durationMs;
        state.snapshotPreparations = (state.snapshotPreparations || 0) + 1;
        const snapshotFile = path.join(folder, `${state.batchId}.snapshot.${generation}.json`);
        persist(snapshotFile, snap);
        save();
        return { snap, snapshotFile, durationMs, createdForTask: task.id };
      }).catch((error) => { snapshotPromise = null; throw error; });
    }
    return snapshotPromise;
  };
  state.invalidateSnapshot = () => { snapshotGeneration++; snapshotPromise = null; };
  state.batchStatus = 'running'; save();
  const running = new Set();
  const jobs = new Map();
  const configuredWorkers = Number.isSafeInteger(state.maxWorkers) ? state.maxWorkers : readUserSettings().maxWorkers;
  const requestedWorkers = Number.isSafeInteger(state.maxParallel) ? state.maxParallel : 1;
  const capacity = Math.max(1, Math.min(MAX_WORKERS_LIMIT, configuredWorkers, requestedWorkers));
  while (true) {
    let started = false;
    for (const [index, t] of state.tasks.entries()) {
      if (running.size >= capacity) break;
      if (!readUserSettings().enabled) {
        for (const queued of state.tasks) if (queued.status === 'queued') { queued.status = state.autoDisabled ? 'quota_blocked' : 'disabled'; queued.error = state.autoDisabledReason || 'Delegation is disabled in router settings.'; }
        save();
        continue;
      }
      if (t.status !== 'queued') continue;
      if (fs.existsSync(path.join(folder, `${t.id}.cancel`))) { t.status = 'cancelled'; save(); continue; }
      if (t.dependsOn.some((id) => state.tasks.find((x) => x.id === id)?.status !== 'completed')) continue;
      if (state.tasks.slice(0, index).some((x) => ['awaiting_integration', 'conflict', 'needs_review'].includes(x.status) && overlaps(x, t))) continue;
      if ([...running].some((x) => overlaps(x, t))) continue;
      t.status = 'starting'; t.dispatchedAt = now(); save(); started = true;
      const job = execute(state.root, folder, state, t, model, timeout, save, provider, workerRunner, getSnapshot).catch((e) => { t.status = 'needs_review'; t.error = e.message; t.finishedAt = now(); save(); }).finally(() => { running.delete(t); });
      jobs.set(t.id, job); running.add(t);
    }
    if (!running.size) break;
    await Promise.race([...running].map((t) => jobs.get(t.id)));
    if (!started) continue;
  }
  for (const t of state.tasks) if (t.status === 'queued') { t.status = 'blocked'; t.error = 'A dependency or earlier overlapping task needs completion or review.'; }
  state.snapshotDurationMs = snapshotDurationMs;
  delete state.invalidateSnapshot;
  state.finishedAt = now(); state.batchStatus = 'finished'; save();
  return report(state);
}
export async function delegate(root, rawTasks, options = {}) {
  const settings = readUserSettings();
  if (!settings.enabled) throw new Error('Antigravity delegation is disabled. Turn it on in the router panel or settings before delegating.');
  const tasks = validate(rawTasks);
  const model = options.model === undefined ? settings.model : validatePreferredModel(options.model, 'model');
  const timeout = options.timeoutSeconds ?? 1200;
  const waitSeconds = options.waitSeconds ?? 20;
  if (!Number.isSafeInteger(timeout) || timeout < 60 || timeout > 3600) throw new Error('timeoutSeconds must be an integer from 60 to 3600.');
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) throw new Error('waitSeconds must be an integer from 0 to 30.');
  if (options.executionMode !== undefined && !['sequential', 'parallel'].includes(options.executionMode)) throw new Error('executionMode must be sequential or parallel.');
  if (options.runMode !== undefined && !['fail-closed', 'trusted-local'].includes(options.runMode)) throw new Error('runMode must be fail-closed or trusted-local.');
  if (options.maxParallel !== undefined && (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > settings.maxWorkers)) {
    throw new Error(`maxParallel must be an integer from 1 to the configured maximum of ${settings.maxWorkers}.`);
  }
  const maxParallel = options.executionMode === 'sequential' ? 1 : options.maxParallel ?? Math.min(settings.maxWorkers, tasks.length);
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1 || maxParallel > settings.maxWorkers) throw new Error(`maxParallel must be an integer from 1 to the configured maximum of ${settings.maxWorkers}.`);
  const runMode = options.runMode || 'fail-closed';
  const provider = options.executionProvider || await configuredExecutionProvider(runMode);
  if (tasks.some((t) => t.verificationCommands.length)) await requireAuthorizedProvider(provider, runMode);
  if (tasks.some((t) => t.verificationCommands.length) && typeof provider.preflight === 'function') {
    for (const t of tasks) for (const command of t.verificationCommands) {
      const checked = await provider.preflight({ taskId: t.id, workspace: canonical(root), command });
      if (checked?.workspace !== canonical(root) || checked?.available !== true) throw new Error(`Verification preflight failed for task ${t.id} (${command[0]}): ${checked?.reason || 'executable availability could not be confirmed'}. No worker was launched.`);
    }
  }
  if (!options.workerRunner) { const ready = await status(root, model); if (!ready.ready) throw new Error(ready.message); }
  const base = stateRoot(root), release = acquire(globalRoot());
  let lockHeld = true;
  try {
    const orphans = liveUnownedWorkers();
    if (orphans.length) throw new Error(`A preserved Antigravity CLI process may still be active: ${JSON.stringify(orphans)}. Inspect or recover it before starting another batch.`);
    const batchId = crypto.randomUUID(), folder = path.join(base, batchId);
    fs.mkdirSync(folder, { recursive: true });
    await managedCheckout(root, batchId, 0);
    const state = { version: 1, batchId, root: canonical(root), model, timeout, runMode, maxWorkers: settings.maxWorkers, maxParallel, revision: 0, batchStatus: 'queued', createdAt: now(), tasks };
    state.stateFile = path.join(folder, 'state.json'); persist(state.stateFile, state);
    release(); lockHeld = false;
    const queued = enqueueBatch(batchId, () => schedule(state, folder, model, timeout, provider, options.workerRunner));
    const completion = queued.completion.catch((error) => { state.controllerError = String(error.message || error).slice(0, 500); state.finishedAt = now(); state.batchStatus = 'failed'; persist(state.stateFile, state); return report(state); });
    if (waitSeconds === 0) return { ...report(state), pending: true, queuePosition: queued.position };
    let timer;
    const early = Symbol('bounded wait expired');
    const result = await Promise.race([completion, new Promise((resolve) => { timer = setTimeout(() => resolve(early), waitSeconds * 1000); })]);
    clearTimeout(timer);
    if (result === early) return { ...report(state), pending: true, queuePosition: queued.position };
    return result;
  } catch (error) { if (lockHeld) release(); throw error; }
}

export async function waitForBatchChange(root, batchId, cursor, waitSeconds = 20) {
  if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('Invalid batch ID.');
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) throw new Error('waitSeconds must be an integer from 0 to 30.');
  const file = path.join(stateRoot(root), batchId, 'state.json');
  const initial = load(file);
  if (normalize(initial.root) !== normalize(canonical(root))) throw new Error('Batch belongs to a different workspace.');
  const deadline = Date.now() + waitSeconds * 1000;
  let state = initial;
  while (state.revision === cursor && Date.now() < deadline && !state.finishedAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    state = load(file);
  }
  return { ...report(state), waitExpired: state.revision === cursor && !state.finishedAt };
}
export async function recover(root, batchId, resume = false, executionProvider = null) {
  const base = stateRoot(root), folder = path.join(base, batchId), file = path.join(folder, 'state.json');
  const state = load(file);
  if (normalize(state.root) !== normalize(canonical(root))) throw new Error('Batch belongs to a different workspace.');
  if (!resume) return report(state);
  if (scheduledBatches.has(batchId)) return { ...report(state), warning: 'This batch is already queued or running in this router process; no duplicate worker dispatch was created.' };
  const release = acquire(globalRoot());
  let lockHeld = true;
  try {
    const orphans = liveUnownedWorkers();
    if (orphans.length) return { ...report(state), warning: `Live worker processes require inspection before queue recovery: ${JSON.stringify(orphans)}` };
    for (const t of state.tasks) if (['starting', 'preparing', 'running', 'retrying', 'verified', 'integrating'].includes(t.status)) {
      t.status = 'needs_review';
      t.error = alive(t.pid) ? `Worker PID ${t.pid} may still be active; inspect before recovery.` : 'Interrupted task preserved; inspect its worktree before retrying.';
    }
    for (const t of state.tasks) if (t.status === 'blocked') { t.status = 'queued'; delete t.error; }
    persist(file, state);
    if (state.tasks.some((t) => alive(t.pid))) return report(state);
    await managedCheckout(root, batchId, 0);
    const provider = executionProvider || await configuredExecutionProvider(state.runMode || 'fail-closed');
    if (state.tasks.some((t) => t.status === 'queued' && t.verificationCommands?.length)) await requireAuthorizedProvider(provider, state.runMode || 'fail-closed');
    state.batchStatus = 'queued'; persist(file, state);
    release(); lockHeld = false;
    const queued = enqueueBatch(batchId, () => schedule(state, folder, state.model, state.timeout, provider));
    return await queued.completion;
  } finally { if (lockHeld) release(); }
}
export async function integrateTask(root, batchId, taskId, executionProvider = null) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('Invalid batch ID.');
  const base = stateRoot(root), release = acquire(globalRoot());
  let lockHeld = true;
  try {
    const orphans = liveUnownedWorkers();
    if (orphans.length) throw new Error(`Live worker processes require inspection before integration: ${JSON.stringify(orphans)}`);
    const file = path.join(base, batchId, 'state.json'), state = load(file);
    if (normalize(state.root) !== normalize(canonical(root))) throw new Error('Batch belongs to a different workspace.');
    if (state.batchStatus === 'running') throw new Error('This batch is still running. Wait for its current tasks to finish before integrating output.');
    const t = state.tasks.find((item) => item.id === taskId);
    if (!t || t.status !== 'awaiting_integration') throw new Error('Task is not awaiting integration.');
    const snap = load(t.snapshotFile), edits = await changed(t.worker, snap);
    if (edits.length !== t.changedFiles.length || edits.some((p, i) => p !== t.changedFiles[i] || hash(safeFile(t.worker, p)) !== t.outputHashes[p])) throw new Error('Worker changed since verification; inspect and verify again.');
    t.status = 'integrating'; persist(file, state);
    const result = await integrate(root, t.worker, snap, edits);
    if (!result.integrated) { t.status = 'conflict'; t.conflicts = result.conflicts; }
    else t.status = 'completed';
    persist(file, state);
    if (result.integrated && state.tasks.some((item) => item.status === 'blocked')) {
      for (const item of state.tasks) if (item.status === 'blocked') { item.status = 'queued'; delete item.error; }
      persist(file, state);
      const provider = executionProvider || await configuredExecutionProvider(state.runMode || 'fail-closed');
      if (state.tasks.some((item) => item.status === 'queued' && item.verificationCommands?.length)) await requireAuthorizedProvider(provider, state.runMode || 'fail-closed');
      state.batchStatus = 'queued'; persist(file, state);
      release(); lockHeld = false;
      const queued = enqueueBatch(batchId, () => schedule(state, path.dirname(file), state.model, state.timeout, provider));
      return await queued.completion;
    }
    return report(state);
  } finally { if (lockHeld) release(); }
}
export function cancelTask(root, batchId, taskId) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('Invalid batch ID.');
  const file = path.join(stateRoot(root), batchId, 'state.json');
  const state = load(file);
  if (normalize(state.root) !== normalize(canonical(root))) throw new Error('Batch belongs to a different workspace.');
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('Unknown task ID.');
  if (['completed', 'cancelled', 'conflict', 'needs_review', 'awaiting_integration'].includes(task.status)) return { taskId, status: task.status, message: 'Task is no longer active; work is preserved.' };
  const marker = path.join(path.dirname(file), `${taskId}.cancel`);
  try { fs.writeFileSync(marker, JSON.stringify({ requestedAt: now() }), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return { taskId, status: 'cancellation_requested', marker };
}
export async function disposeTask(root, batchId, taskId) {
  const base = stateRoot(root), release = acquire(globalRoot());
  try {
    const file = path.join(base, batchId, 'state.json'), state = load(file);
    if (normalize(state.root) !== normalize(canonical(root))) throw new Error('Batch belongs to another workspace.');
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !['completed', 'cancelled'].includes(task.status)) throw new Error('Only completed or cancelled work can be disposed.');
    if (task.workerDisposedAt) return { taskId, disposed: true, alreadyDisposed: true, workerPath: task.workerPath };
    const snap = load(task.snapshotFile);
    const result = await disposeWorker(root, task.worker, snap);
    if (result.disposed) { task.workerDisposedAt = now(); task.workerPath = task.worker; task.worker = null; persist(file, state); }
    return { taskId, ...result };
  } finally { release(); }
}
