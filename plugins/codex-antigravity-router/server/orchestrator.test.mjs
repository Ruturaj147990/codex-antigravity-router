import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { delegationDefaults, resolveDelegationOptions } from './index.mjs';
import { buildAgentPrompt, cancelTask, dashboardAgents, delegate, describeCliTimeout, describeDenial, disposeTask, integrateTask, quotaExhaustionReason, recover, waitForBatchChange } from './orchestrator.mjs';

test('quota failures are classified without treating ordinary failures as exhaustion', () => {
  assert.match(quotaExhaustionReason({ stderr: 'HTTP 429 RESOURCE_EXHAUSTED: quota exceeded' }), /quota exceeded/i);
  assert.match(quotaExhaustionReason({ result: { response: 'Weekly quota limit reached' } }), /weekly quota/i);
  assert.equal(quotaExhaustionReason({ stderr: 'socket closed unexpectedly' }), null);
});

test('CLI print timeout reports the shared deadline and non-resumable turn state', () => {
  const details = describeCliTimeout({ processExited: true, result: { status: 'DEADLINE_EXCEEDED', reason: 'print_timeout', retryable: false } }, 180);
  assert.equal(details.source, 'antigravity_print_timeout');
  assert.equal(details.submissionTimeoutSeconds, 180);
  assert.equal(details.cliPrintTimeoutSeconds, 180);
  assert.equal(details.watchdogTerminationAtSeconds, 195);
  assert.equal(details.cliProcessState, 'exited');
  assert.equal(details.remoteTurnState, 'reported_in_progress_by_cli');
  assert.equal(details.resumable, false);
  assert.equal(details.cliRetryable, false);
  assert.match(details.message, /cannot resume that turn/);
});

test('dashboard includes recently completed workers with legacy Windows timestamps', (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-dashboard-state-'));
  const oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT;
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateRoot;
  t.after(() => { if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState; fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const root = path.join(stateRoot, 'repo-hash'), folder = path.join(root, 'batch-id');
  fs.mkdirSync(folder, { recursive: true });
  const d = new Date(), pad = (v) => String(v).padStart(2, '0');
  const legacyTime = `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify({ root: 'demo-project', model: 'test-model', tasks: [{ id: 'demo', title: 'Create demo artifact', status: 'completed', finishedAt: legacyTime }] }));
  assert.deepEqual(dashboardAgents(), [{ name: 'Worker demo', task: 'Create demo artifact', phase: 'completed', live: false, workspace: 'demo-project', model: 'test-model', startedAt: null }]);
});

test('quota exhaustion preserves state, disables future delegation, and skips queued tasks', async (t) => {
  const root = fixture(), settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-quota-settings-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-quota-state-'));
  const oldSettings = process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE, oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT;
  process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = path.join(settingsRoot, 'settings.json');
  fs.writeFileSync(process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE, JSON.stringify({ enabled: true, maxWorkers: 4, model: 'gemini-3.8-flash-low' }));
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateRoot;
  t.after(() => { if (oldSettings === undefined) delete process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE; else process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = oldSettings; if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState; fs.rmSync(settingsRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); });
  const tasks = ['quota', 'queued'].map((id) => ({ id, title: `Task ${id}`, risk: 'LOW_RISK', instructions: 'Test quota stop.', allowedPaths: [`${id}.txt`], acceptanceCriteria: ['Task outcome is preserved'] }));
  const started = [];
  const report = await delegate(root, tasks, { maxParallel: 1, workerRunner: async ({ task }) => { started.push(task.id); return { code: 1, stderr: 'HTTP 429 RESOURCE_EXHAUSTED: weekly quota exceeded', result: { status: 'ERROR', response: 'Quota exhausted' }, observedCwd: null, denied: [], tools: [], briefCharacters: 10 }; } });
  assert.deepEqual(started, ['quota']);
  assert.equal(report.results[0].status, 'quota_exhausted');
  assert.equal(report.results[1].status, 'quota_blocked');
  assert.equal(JSON.parse(fs.readFileSync(process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE, 'utf8')).enabled, false);
  await assert.rejects(delegate(root, [tasks[0]], { workerRunner: async () => { throw new Error('must not launch'); } }), /delegation is disabled/);
});

test('installed defaults honor a configurable model and worker ceiling', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-defaults-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: home, CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE: 'trusted-local', CODEX_ANTIGRAVITY_MAX_WORKERS: '6', CODEX_ANTIGRAVITY_MODEL: 'gemini-3.8-flash-medium' };
  const defaults = delegationDefaults(env);
  assert.equal(defaults.runMode, 'trusted-local');
  assert.throws(() => resolveDelegationOptions({ runMode: 'trusted-local' }, { ...defaults, runMode: 'fail-closed' }), /not enabled.*restart Codex/i);
  assert.equal(defaults.maxWorkers, 6);
  assert.equal(defaults.model, 'gemini-3.8-flash-medium');
  const options = resolveDelegationOptions({ tasks: Array.from({ length: 7 }) }, defaults);
  assert.equal(options.maxParallel, 6);
  assert.equal(resolveDelegationOptions({ tasks: [1, 2], maxParallel: 1 }, defaults).maxParallel, 1);
  assert.equal(resolveDelegationOptions({ tasks: [1, 2], executionMode: 'sequential' }, defaults).maxParallel, 1);
  assert.equal(resolveDelegationOptions({ tasks: [1, 2], model: 'gpt-oss-120b-medium' }, { ...defaults, model: 'gemini-3.8-flash-high' }).model, 'gemini-3.8-flash-high');
  assert.throws(() => resolveDelegationOptions({ tasks: Array.from({ length: 7 }), maxParallel: 7 }, defaults), /configured maximum of 6/);
  assert.throws(() => resolveDelegationOptions({ tasks: [1], executionMode: 'parallel-ish' }, defaults), /executionMode must be/);
  assert.throws(() => resolveDelegationOptions({ tasks: [1], runMode: 'untrusted' }, defaults), /runMode must be/);
});

test('Antigravity prompt marks every supplied check mandatory and forbids agent command tools', () => {
  const brief = buildAgentPrompt('C:/worker', {
    title: 'Test task', risk: 'LOW_RISK', instructions: 'Change the implementation.',
    allowedPaths: ['src/a.js'], acceptanceCriteria: ['The behavior works.'],
    verificationCommands: [['node', '--test', 'test.mjs']]
  });
  assert.match(brief, /do not call terminal, command, notebook, or code-execution tools/i);
  assert.match(brief, /mandatory controller checks \(all run in listed order\)/i);
  assert.doesNotMatch(brief, /choose which listed checks/i);
  assert.match(brief, /Do not use MCP tools, external lookup/i);
});

test('permission diagnostics retain structured scope and stage without exposing outside paths', () => {
  const root = path.resolve('worker');
  assert.match(describeDenial({ action: 'read_file', path: 'src/types.ts', rule: 'file_scope' }, root), /rule=file_scope; scope=src\/types.ts/);
  const denied = describeDenial({ action: 'mcp', server: 'docs', tool: 'lookup', phase: 'dispatch',
    path: path.resolve('secret-project', 'secret.txt'), executed: false }, root);
  assert.match(denied, /server=docs; tool=lookup.*outside assigned worktree.*phase=dispatch; executed=no/);
  assert.doesNotMatch(denied, /secret/);
});

test('verification failures retain stdout, stderr, exit status, timeout and duration for repair', async (t) => {
  const root = fixture(); process.env.CODEX_ANTIGRAVITY_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-diagnostics-'));
  t.after(() => fs.rmSync(process.env.CODEX_ANTIGRAVITY_STATE_ROOT, { recursive: true, force: true }));
  const diagnosticsProvider = { ...provider, run: async ({ workspace }) => ({ workspace, exitCode: 1, timedOut: false, durationMs: 31, stdoutTail: 'verbose output '.repeat(400) + 'AssertionError: expected digest 1234', stderrTail: 'pytest collection warning' }) };
  const task = { id: 'diagnostics', title: 'Preserve diagnostics', risk: 'LOW_RISK', instructions: 'Create a file.', allowedPaths: ['diagnostic.txt'], acceptanceCriteria: ['Check failure remains actionable'], verificationCommands: [['pytest', '-q', 'a long suite path']] };
  let repairBrief;
  const result = await delegate(root, [task], { workerRunner: async ({ worker, retry }) => { if (retry) repairBrief = buildAgentPrompt(worker, task, retry); fs.writeFileSync(path.join(worker, 'diagnostic.txt'), 'output'); return { code: 0, result: { status: 'SUCCESS', response: 'done' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 1 }; }, executionProvider: diagnosticsProvider });
  const check = result.results[0].checks[0];
  assert.equal(check.exitCode, 1); assert.equal(check.durationMs, 31);
  assert.match(check.stdoutTail, /digest 1234/); assert.match(check.stderrTail, /collection warning/);
  assert.match(repairBrief, /AssertionError: expected digest 1234/);
  assert.doesNotMatch(repairBrief, /a long suite path/);
});

test('bounded delegation wait returns a durable batch handle and cursor before work finishes', async (t) => {
  const root = fixture(), oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT, stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-bounded-wait-'));
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateDir;
  t.after(() => { if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState; fs.rmSync(stateDir, { recursive: true, force: true }); });
  const task = { id: 'slow', title: 'Slow task', risk: 'LOW_RISK', instructions: 'Write a file.', allowedPaths: ['slow.txt'], acceptanceCriteria: ['File exists'] };
  const submitted = await delegate(root, [task], { waitSeconds: 0, workerRunner: async ({ worker }) => { await new Promise((resolve) => setTimeout(resolve, 100)); fs.writeFileSync(path.join(worker, 'slow.txt'), 'done'); return { code: 0, result: { status: 'SUCCESS', response: 'done' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 1 }; } });
  assert.equal(submitted.pending, true); assert.match(submitted.batchId, /^[0-9a-f-]{36}$/); assert.ok(Number.isInteger(submitted.cursor));
  const changedState = await waitForBatchChange(root, submitted.batchId, submitted.cursor, 5);
  assert.ok(changedState.cursor > submitted.cursor);
  let finished = changedState;
  for (let attempt = 0; attempt < 10 && finished.results[0].status !== 'awaiting_integration'; attempt++) finished = await waitForBatchChange(root, submitted.batchId, finished.cursor, 5);
  assert.equal(finished.results[0].status, 'awaiting_integration');
});

test('independent submissions queue FIFO while an owned worker is active', async (t) => {
  const root = fixture(), stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-batch-queue-'));
  const oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT, oldSettings = process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE;
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-batch-queue-settings-'));
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateDir;
  process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE, JSON.stringify({ enabled: true, maxWorkers: 4, model: 'gemini-3.8-flash-low' }));
  t.after(() => { if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState; if (oldSettings === undefined) delete process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE; else process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = oldSettings; fs.rmSync(stateDir, { recursive: true, force: true }); fs.rmSync(settingsDir, { recursive: true, force: true }); });
  let signalStarted, releaseFirst;
  const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  const workerRunner = async ({ worker, task, onPid }) => {
    onPid(process.pid); started.push(task.id);
    if (task.id === 'first') { signalStarted(); await firstGate; }
    fs.writeFileSync(path.join(worker, `${task.id}.txt`), task.id);
    return { code: 0, result: { status: 'SUCCESS', response: 'done' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 1 };
  };
  const task = (id) => ({ id, title: id, risk: 'HIGH_RISK', instructions: 'Write the assigned file.', allowedPaths: [`${id}.txt`], acceptanceCriteria: ['File exists'] });
  const firstPromise = delegate(root, [task('first')], { workerRunner });
  await firstStarted;
  const second = await delegate(root, [task('second')], { workerRunner, waitSeconds: 0 });
  assert.equal(second.pending, true);
  assert.equal(second.queuePosition, 1);
  assert.deepEqual(started, ['first']);
  const duplicateRecovery = await recover(root, second.batchId, true);
  assert.match(duplicateRecovery.warning, /already queued or running/i);
  try {
    const other = await delegate(fixture(), [task('other-repo')], { workerRunner, waitSeconds: 10 });
    assert.equal(other.results[0].status, 'awaiting_integration');
    assert.deepEqual(started, ['first', 'other-repo']);
  } finally {
    releaseFirst();
  }
  const first = await firstPromise;
  assert.equal(first.results[0].status, 'awaiting_integration');
  for (let i = 0; i < 50 && !started.includes('second'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ['first', 'other-repo', 'second']);
  let latest = await waitForBatchChange(root, second.batchId, second.cursor, 5);
  for (let i = 0; i < 10 && latest.results[0].status !== 'awaiting_integration'; i++) latest = await waitForBatchChange(root, second.batchId, latest.cursor, 5);
  assert.equal(latest.results[0].status, 'awaiting_integration');
});

test('failed snapshot before worktree creation remains recoverable with an accurate report', async (t) => {
  const root = fixture(), stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-setup-failure-'));
  const oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT;
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateDir;
  t.after(() => { if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState; fs.rmSync(stateDir, { recursive: true, force: true }); });
  const task = { id: 'badglob', title: 'Failure fixture', risk: 'LOW_RISK', instructions: 'Write a file.', allowedPaths: ['bad/**oops'], acceptanceCriteria: ['File exists'] };
  let launched = false;
  const result = await delegate(root, [task], { snapshotFn: async () => { throw new Error('Git ls-files forced setup failure'); }, workerRunner: async () => { launched = true; throw new Error('unexpected launch'); } });
  assert.equal(result.results[0].status, 'needs_review');
  assert.equal(result.results[0].workerPathStatus, 'planned_only');
  assert.equal(result.results[0].workerLaunched, false);
  assert.equal(result.results[0].retryPossible, true);
  assert.match(result.results[0].error, /source snapshot.*Git ls-files/);
  assert.equal(launched, false);
  const recovered = await recover(root, result.batchId);
  assert.equal(recovered.results[0].workerPathStatus, 'planned_only');
  assert.equal(recovered.results[0].retryPossible, true);
  assert.equal(recovered.results[0].workerLaunched, false);
});

test('parallel tasks in one batch reuse their immutable source snapshot', async (t) => {
  const root = fixture(), stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-snapshot-reuse-'));
  const oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT;
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateDir;
  t.after(() => { if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState; fs.rmSync(stateDir, { recursive: true, force: true }); });
  const tasks = ['one', 'two'].map((id) => ({ id, title: id, risk: 'HIGH_RISK', instructions: 'Write the assigned file.', allowedPaths: [`${id}.txt`], acceptanceCriteria: ['File exists'] }));
  const workerRunner = async ({ worker, task }) => {
    fs.writeFileSync(path.join(worker, `${task.id}.txt`), task.id);
    return { code: 0, result: { status: 'SUCCESS', response: 'done' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 1 };
  };
  const result = await delegate(root, tasks, { maxParallel: 2, workerRunner });
  assert.equal(result.snapshotPreparations, 1);
  assert.equal(result.results.filter((item) => item.snapshotDurationMs > 0).length, 1);
  const state = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));
  assert.equal(state.tasks[0].snapshotFile, state.tasks[1].snapshotFile);
  assert.deepEqual(result.results.map((item) => item.status), ['awaiting_integration', 'awaiting_integration']);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-scheduler-test-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.txt'), 'fixture');
  execFileSync('git', ['add', 'README.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
const provider = {
  capabilities: async () => ({ isolated: true, workspaceBound: true, capturesExitStatus: true }),
  run: async ({ workspace, command }) => ({ workspace, exitCode: fs.readFileSync(path.join(workspace, command[0]), 'utf8') === command[1] ? 0 : 1, output: 'fixture assertion' })
};

test('print timeout details persist in the batch report and recovery view', async (t) => {
  const root = fixture(), stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-timeout-state-'));
  const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-timeout-settings-'));
  const oldState = process.env.CODEX_ANTIGRAVITY_STATE_ROOT, oldSettings = process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE;
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateRoot;
  process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = path.join(settingsRoot, 'settings.json');
  fs.writeFileSync(process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE, JSON.stringify({ enabled: true, maxWorkers: 4, model: 'gemini-3.8-flash-low' }));
  t.after(() => {
    if (oldState === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT; else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = oldState;
    if (oldSettings === undefined) delete process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE; else process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = oldSettings;
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); fs.rmSync(settingsRoot, { recursive: true, force: true });
  });
  const tasks = [{ id: 'print_timeout', title: 'Create a verifier', risk: 'LOW_RISK', instructions: 'Create the requested script.', allowedPaths: ['scripts/verify.py'], acceptanceCriteria: ['The verifier exists.'] }];
  const result = await delegate(root, tasks, {
    timeoutSeconds: 180, maxParallel: 1,
    workerRunner: async () => ({ code: 0, timedOut: false, processExited: true, result: { status: 'DEADLINE_EXCEEDED', reason: 'print_timeout', retryable: false }, observedCwd: null, denied: [], tools: [], stderr: '', briefCharacters: 80, durationMs: 180000 })
  });
  assert.equal(result.timeoutPolicy.submissionTimeoutSeconds, 180);
  assert.equal(result.timeoutPolicy.cliPrintTimeoutSeconds, 180);
  assert.equal(result.timeoutPolicy.controllerTerminatesAtSeconds, 195);
  assert.equal(result.results[0].status, 'needs_review');
  assert.equal(result.results[0].timeoutDetails.cliProcessState, 'exited');
  assert.equal(result.results[0].timeoutDetails.remoteTurnState, 'reported_in_progress_by_cli');
  assert.equal(result.results[0].turnResumable, false);
  assert.equal(result.results[0].timeoutDetails.cliRetryable, false);
  assert.equal(result.results[0].workerPathStatus, 'exists');
  const recovered = await recover(root, result.batchId);
  assert.equal(recovered.results[0].timeoutDetails.resumable, false);
  assert.equal(recovered.results[0].status, 'needs_review');
});

test('seven simulated editors obey the configured six-worker cap and FIFO dispatch', async (t) => {
  const root = fixture();
  const previousStateRoot = process.env.CODEX_ANTIGRAVITY_STATE_ROOT;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-'));
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = stateRoot;
  const settingsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'router-workers-six-'));
  const settingsFile = path.join(settingsHome, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ model: 'gemini-3.8-flash-low', maxWorkers: 6 }));
  const previousSettingsFile = process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE;
  process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = settingsFile;
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.CODEX_ANTIGRAVITY_STATE_ROOT;
    else process.env.CODEX_ANTIGRAVITY_STATE_ROOT = previousStateRoot;
    if (previousSettingsFile === undefined) delete process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE;
    else process.env.CODEX_ANTIGRAVITY_SETTINGS_FILE = previousSettingsFile;
    fs.rmSync(settingsHome, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  let active = 0, peak = 0, reachedSix = false, releaseSix;
  const sixStarted = new Promise((resolve) => { releaseSix = resolve; });
  const started = [];
  const workerRunner = async ({ worker, task }) => {
    active++; peak = Math.max(peak, active); started.push(task.id);
    if (active === 6) { reachedSix = true; releaseSix(); }
    await Promise.race([sixStarted, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.writeFileSync(path.join(worker, `${task.id}.txt`), task.id);
    active--;
    return { code: 0, timedOut: false, result: { status: 'SUCCESS', response: 'Completed', usage: { total_tokens: 0 } }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 20 };
  };
  const tasks = Array.from({ length: 7 }, (_, i) => ({ id: `task${i}`, title: `Task ${i}`, risk: 'LOW_RISK', instructions: 'Write one file.', allowedPaths: [`task${i}.txt`], acceptanceCriteria: ['File is correct'], verificationCommands: [[`task${i}.txt`, `task${i}`]] }));
  const report = await delegate(root, tasks, { maxParallel: 6, workerRunner, executionProvider: provider });
  assert.equal(report.completed, 7);
  assert.equal(report.model, 'gemini-3.8-flash-low');
  assert.equal(report.maxWorkers, 6);
  assert.equal(report.maxParallel, 6);
  assert.equal(peak, 6);
  assert.equal(reachedSix, true);
  assert.deepEqual(new Set(started.slice(0, 6)), new Set(tasks.slice(0, 6).map((t) => t.id)));
  assert.equal(started[6], 'task6');
  for (const task of tasks) assert.equal(fs.readFileSync(path.join(root, `${task.id}.txt`), 'utf8'), task.id);
});

test('HIGH_RISK output waits for an explicit integration decision', async () => {
  const root = fixture();
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-'));
  const task = { id: 'high', title: 'High risk edit', risk: 'HIGH_RISK', instructions: 'Create a controlled file.', allowedPaths: ['high.txt'], acceptanceCriteria: ['File is correct'], verificationCommands: [['high.txt', 'correct']] };
  const workerRunner = async ({ worker }) => {
    fs.writeFileSync(path.join(worker, 'high.txt'), 'correct');
    return { code: 0, timedOut: false, result: { status: 'SUCCESS', response: 'Completed' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 20 };
  };
  const result = await delegate(root, [task], { workerRunner, executionProvider: provider });
  assert.equal(result.results[0].status, 'awaiting_integration');
  assert.equal(fs.existsSync(path.join(root, 'high.txt')), false);
  const integrated = await integrateTask(root, result.batchId, task.id);
  assert.equal(integrated.results[0].status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'high.txt'), 'utf8'), 'correct');
});

test('failed verification returns to the worker for autonomous repair', async () => {
  const root = fixture();
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-'));
  let attempts = 0;
  const task = { id: 'repair', title: 'Repair result', risk: 'LOW_RISK', instructions: 'Create and fix a controlled file.', allowedPaths: ['repair.txt'], acceptanceCriteria: ['File is correct'], verificationCommands: [['repair.txt', 'correct']] };
  const workerRunner = async ({ worker, retry }) => {
    attempts++;
    fs.writeFileSync(path.join(worker, 'repair.txt'), retry ? 'correct' : 'wrong');
    return { code: 0, timedOut: false, result: { status: 'SUCCESS', response: 'Checked' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 20 };
  };
  const result = await delegate(root, [task], { workerRunner, executionProvider: provider });
  assert.equal(attempts, 2);
  assert.equal(result.results[0].status, 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'repair.txt'), 'utf8'), 'correct');
});

test('risk escalation blocks dependents while unrelated ready work proceeds', async () => {
  const root = fixture();
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-'));
  const tasks = [
    { id: 'risky', title: 'Risky task', risk: 'LOW_RISK', instructions: 'Investigate scope.', allowedPaths: ['risky.txt'], acceptanceCriteria: ['Report scope'] },
    { id: 'dependent', title: 'Dependent task', risk: 'LOW_RISK', instructions: 'Wait for risky task.', dependsOn: ['risky'], allowedPaths: ['dependent.txt'], acceptanceCriteria: ['File is correct'], verificationCommands: [['dependent.txt', 'dependent']] },
    { id: 'independent', title: 'Independent task', risk: 'LOW_RISK', instructions: 'Write file.', allowedPaths: ['independent.txt'], acceptanceCriteria: ['File is correct'], verificationCommands: [['independent.txt', 'independent']] }
  ];
  const workerRunner = async ({ worker, task }) => {
    if (task.id !== 'risky') fs.writeFileSync(path.join(worker, `${task.id}.txt`), task.id);
    return { code: 0, timedOut: false, result: { status: 'SUCCESS', response: task.id === 'risky' ? 'ESCALATE_RISK: shared contract must change' : 'Completed' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 20 };
  };
  const report = await delegate(root, tasks, { maxParallel: 2, workerRunner, executionProvider: provider });
  assert.deepEqual(report.results.map((r) => r.status), ['needs_review', 'blocked', 'completed']);
});

test('active cancellation preserves partial files and never integrates them', async () => {
  const root = fixture(); process.env.CODEX_ANTIGRAVITY_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-'));
  let signal; const started = new Promise((r) => { signal = r; }); let workerPath;
  const task = { id: 'cancelme', title: 'Cancel active task', risk: 'LOW_RISK', instructions: 'Write partial output.', allowedPaths: ['partial.txt'], acceptanceCriteria: ['Never integrate after cancellation'], verificationCommands: [['partial.txt', 'complete']] };
  const workerRunner = async ({ worker, cancelFile }) => { workerPath = worker; fs.writeFileSync(path.join(worker, 'partial.txt'), 'unfinished'); signal(); while (!fs.existsSync(cancelFile)) await new Promise((r) => setTimeout(r, 10)); return { code: 1, cancelled: true, result: null, observedCwd: worker, denied: [], tools: [], stderr: 'terminated', briefCharacters: 20 }; };
  const pending = delegate(root, [task], { workerRunner, executionProvider: provider }); await started;
  const reportDir = path.join(process.env.CODEX_ANTIGRAVITY_STATE_ROOT, fs.readdirSync(process.env.CODEX_ANTIGRAVITY_STATE_ROOT).find((x) => x !== 'controller.lock'));
  const batchId = fs.readdirSync(reportDir).find((name) => /^[0-9a-f-]{36}$/i.test(name));
  assert.equal(cancelTask(root, batchId, task.id).status, 'cancellation_requested');
  const result = await pending;
  assert.equal(result.results[0].status, 'cancelled'); assert.equal(result.completed, 0);
  assert.equal(fs.readFileSync(path.join(workerPath, 'partial.txt'), 'utf8'), 'unfinished');
  assert.equal(fs.existsSync(path.join(root, 'partial.txt')), false);
});

test('safe disposition is idempotent and refuses ignored worker-only files', async () => {
  const root = fixture(); process.env.CODEX_ANTIGRAVITY_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'router-state-'));
  const task = { id: 'disposable', title: 'Create safe file', risk: 'LOW_RISK', instructions: 'Write file.', allowedPaths: ['safe.txt'], acceptanceCriteria: ['Exists'], verificationCommands: [['safe.txt', 'ok']] };
  const workerRunner = async ({ worker }) => { fs.writeFileSync(path.join(worker, 'safe.txt'), 'ok'); return { code: 0, result: { status: 'SUCCESS', response: 'done' }, observedCwd: worker, denied: [], tools: [], stderr: '', briefCharacters: 5 }; };
  const done = await delegate(root, [task], { workerRunner, executionProvider: provider });
  assert.equal((await disposeTask(root, done.batchId, task.id)).disposed, true);
  assert.equal((await disposeTask(root, done.batchId, task.id)).disposed, true);
});
