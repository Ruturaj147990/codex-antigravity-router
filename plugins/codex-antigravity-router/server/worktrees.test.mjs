import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquire, changed, createWorker, integrate, persist, snapshot, stateRoot } from './worktrees.mjs';
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
