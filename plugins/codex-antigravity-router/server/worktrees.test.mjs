import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquire, changed, createWorker, git, hash, integrate, persist, snapshot, stateRoot, withGitLogs } from './worktrees.mjs';
import { recover } from './orchestrator.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-worktree-test-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true });
  run('init', '-q');
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  run('add', 'a.txt');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  return root;
}

test('dirty user files are copied by value, and conflicting integration preserves both sides', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'a.txt'), 'uncommitted user edit\n');
  const snap = await snapshot(root), folder = path.join(os.tmpdir(), `router-managed-${path.basename(root)}`);
  fs.mkdirSync(folder, { recursive: true });
  const worker = await createWorker(root, folder, 'worker1', snap);
  assert.equal(fs.readFileSync(path.join(worker, 'a.txt'), 'utf8'), 'uncommitted user edit\n');
  fs.writeFileSync(path.join(worker, 'b.txt'), 'worker edit\n');
  assert.deepEqual(await changed(worker, snap), ['b.txt']);
  fs.writeFileSync(path.join(root, 'b.txt'), 'new user edit\n');
  assert.deepEqual(await integrate(root, worker, snap, ['b.txt']), { integrated: false, conflicts: ['b.txt'] });
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'new user edit\n');
  assert.equal(fs.readFileSync(path.join(worker, 'b.txt'), 'utf8'), 'worker edit\n');
});

test('interrupted work is retained and never automatically resubmitted', async () => {
  const root = fixture(), managed = fs.mkdtempSync(path.join(os.tmpdir(), 'router-recovery-'));
  process.env.CODEX_ANTIGRAVITY_STATE_ROOT = managed;
  const batchId = '11111111-1111-4111-8111-111111111111';
  const file = path.join(stateRoot(root), batchId, 'state.json');
  const worker = path.join(path.dirname(file), 'worker1');
  fs.mkdirSync(worker, { recursive: true });
  fs.writeFileSync(path.join(worker, 'important.txt'), 'preserved\n');
  persist(file, { version: 1, batchId, root, model: 'test', timeout: 60, maxParallel: 1, stateFile: file, tasks: [{ id: 'worker1', risk: 'LOW_RISK', status: 'running', worker, dependsOn: [], allowedPaths: ['important.txt'] }] });
  const result = await recover(root, batchId, true);
  assert.equal(result.results[0].status, 'needs_review');
  assert.equal(fs.readFileSync(path.join(worker, 'important.txt'), 'utf8'), 'preserved\n');
});

test('the controller lock rejects concurrent ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-global-lock-'));
  const release = acquire(root);
  assert.throws(() => acquire(root), /controller is active/);
  release();
  const releaseAgain = acquire(root);
  releaseAgain();
});

test('scoped snapshots exclude unrelated untracked datasets and preserve allowed files', async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'dataset'));
  for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(root, 'dataset', `${i}.txt`), 'data');
  fs.writeFileSync(path.join(root, 'audit.py'), 'existing user work');
  const snap = await snapshot(root, ['audit.py']);
  assert.equal(snap.untracked.length, 1);
  assert.equal(snap.untracked[0], 'audit.py');
  const worker = await createWorker(root, fs.mkdtempSync(path.join(os.tmpdir(), 'router-scoped-')), 'task', snap);
  assert.equal(fs.readFileSync(path.join(worker, 'audit.py'), 'utf8'), 'existing user work');
  assert.equal(fs.existsSync(path.join(worker, 'dataset')), false);
  fs.writeFileSync(path.join(worker, 'out-of-scope.txt'), 'new output');
  assert.deepEqual(await changed(worker, snap), ['out-of-scope.txt']);
});

test('verbose git failure retains full output and identifies its log', async (t) => {
  const root = fixture(), logs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-verbose-'));
  t.after(() => fs.rmSync(logs, { recursive: true, force: true }));
  const empty = path.join(root, 'empty.txt'), large = path.join(root, 'large.txt');
  fs.writeFileSync(empty, '');
  const fd = fs.openSync(large, 'w');
  try { const line = Buffer.from(`${'x'.repeat(1023)}\n`); for (let i = 0; i < 66000; i++) fs.writeSync(fd, line); }
  finally { fs.closeSync(fd); }
  let failure;
  try { await withGitLogs(logs, () => git(root, 'diff', '--no-index', '--text', '--', empty, large)); }
  catch (error) { failure = error; }
  assert.match(failure.message, /Git diff --no-index failed/);
  const files = fs.readdirSync(logs);
  assert.equal(files.length, 1);
  assert.ok(fs.statSync(path.join(logs, files[0])).size > 64 * 1024 * 1024);
  assert.ok(failure.message.includes(files[0]));
});

test('snapshot streams a patch larger than 64 MiB into a worker', async (t) => {
  const root = fixture(), logs = fs.mkdtempSync(path.join(os.tmpdir(), 'router-large-patch-'));
  t.after(() => fs.rmSync(logs, { recursive: true, force: true }));
  const large = path.join(root, 'large.txt');
  fs.writeFileSync(large, 'original\n');
  execFileSync('git', ['add', 'large.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'large base'], { cwd: root });
  const fd = fs.openSync(large, 'w');
  try { const line = Buffer.from(`${'x'.repeat(1023)}\n`); for (let i = 0; i < 66000; i++) fs.writeSync(fd, line); }
  finally { fs.closeSync(fd); }
  const snap = await withGitLogs(logs, () => snapshot(root, []));
  assert.ok(fs.statSync(snap.patchFile).size > 64 * 1024 * 1024);
  const worker = await withGitLogs(logs, () => createWorker(root, logs, 'large-worker', snap));
  assert.equal(hash(path.join(worker, 'large.txt')), hash(large));
});

test('snapshot hashes a sparse nonignored file larger than 2 GiB with bounded memory', () => {
  const root = fixture(), large = path.join(root, 'large.bin'), fd = fs.openSync(large, 'w');
  try { fs.ftruncateSync(fd, 2 * 1024 * 1024 * 1024 + 17); } finally { fs.closeSync(fd); }
  const digest = hash(large), snap = snapshot(root);
  assert.match(digest, /^[0-9a-f]{64}$/);
  return snap.then((value) => assert.equal(value.files['large.bin'], digest));
});
