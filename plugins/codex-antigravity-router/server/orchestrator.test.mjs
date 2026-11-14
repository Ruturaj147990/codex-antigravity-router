import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { delegationDefaults, resolveDelegationOptions } from './index.mjs';
import { buildAgentPrompt, cancelTask, dashboardAgents, delegate, disposeTask, integrateTask, quotaExhaustionReason } from './orchestrator.mjs';

test('quota failures are classified without treating ordinary failures as exhaustion', () => {
  assert.match(quotaExhaustionReason({ stderr: 'HTTP 429 RESOURCE_EXHAUSTED: quota exceeded' }), /quota exceeded/i);
  assert.match(quotaExhaustionReason({ result: { response: 'Weekly quota limit reached' } }), /weekly quota/i);
  assert.equal(quotaExhaustionReason({ stderr: 'socket closed unexpectedly' }), null);
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
  assert.throws(() => resolveDelegationOptions({ runMode: 'trusted-local' }, { ...defaults, runMode: 'fail-closed' }), /requires the operator/);
  assert.equal(defaults.maxWorkers, 6);
  assert.equal(defaults.model, 'gemini-3.8-flash-medium');
  const options = resolveDelegationOptions({ tasks: Array.from({ length: 7 }) }, defaults);
  assert.equal(options.maxParallel, 6);
  assert.equal(resolveDelegationOptions({ tasks: [1, 2], maxParallel: 1 }, defaults).maxParallel, 1);
  assert.equal(resolveDelegationOptions({ tasks: [1, 2], executionMode: 'sequential' }, defaults).maxParallel, 1);
  assert.equal(resolveDelegationOptions({ tasks: [1, 2], model: ' custom-model ' }, defaults).model, 'custom-model');
  assert.throws(() => resolveDelegationOptions({ tasks: Array.from({ length: 7 }), maxParallel: 7 }, defaults), /configured maximum of 6/);
  assert.throws(() => resolveDelegationOptions({ tasks: [1], model: '  ' }, defaults), /model must be a non-empty/);
  assert.throws(() => resolveDelegationOptions({ tasks: [1], executionMode: 'parallel-ish' }, defaults), /executionMode must be/);
  assert.throws(() => resolveDelegationOptions({ tasks: [1], runMode: 'untrusted' }, defaults), /runMode must be/);
});

test('Antigravity prompt routes selected checks to the controller and forbids agent command tools', () => {
  const brief = buildAgentPrompt('C:/worker', {
    title: 'Test task', risk: 'LOW_RISK', instructions: 'Change the implementation.',
    allowedPaths: ['src/a.js'], acceptanceCriteria: ['The behavior works.'],
    verificationCommands: [['node', '--test', 'test.mjs']]
  });
  assert.match(brief, /do not call terminal, command, notebook, or code-execution tools/i);
  assert.match(brief, /controller executes the selected checks/i);
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
  const batchId = fs.readdirSync(reportDir)[0];
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
