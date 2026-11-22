import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delegate, integrateTask, recover, waitForBatchChange } from './orchestrator.mjs';
import { readUserSettings } from './settings.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-router-real-'));
process.env.CODEX_ANTIGRAVITY_STATE_ROOT = path.join(os.tmpdir(), `antigravity-router-managed-${path.basename(root)}`);
function git(...args) { return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }); }
git('init', '-q');
fs.writeFileSync(path.join(root, 'README.txt'), 'This repository tests isolated concurrent file edits.\n');
git('add', 'README.txt');
execFileSync('git', ['-c', 'user.name=Router Test', '-c', 'user.email=router@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true });
const count = Number(process.argv[2] || 2);
const input = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-smoke-input-')), 'input.txt');
fs.writeFileSync(input, 'context-marker\n');
const stagingScript = fileURLToPath(new URL('./stage-context.mjs', import.meta.url));
const { contextPaths } = JSON.parse(execFileSync(process.execPath, [stagingScript, root, input], { encoding: 'utf8' }));
if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new Error('Task count must be from 1 to 32.');
const tasks = Array.from({ length: count }, (_, i) => {
  const file = `result-${i + 1}.txt`, value = `worker-${i + 1}`;
  return {
    id: `worker${i + 1}`, title: `Create ${file}`, risk: process.argv[3] === 'high' ? 'HIGH_RISK' : 'LOW_RISK',
    context: 'This is a controlled concurrency test in an isolated temporary Git repository.',
    instructions: process.argv[3] === 'escalate' ? `This task requires changing ${file} and shared-config.txt together. Only ${file} is allowed. Stop without editing and start your final reply with ESCALATE_RISK: followed by the missing scope.` : `Read the supplied context file first. Create only ${file} with its text, then ${value}, separated by a space and followed by a newline. Use the file writing tool. Do not run shell commands.`,
    contextPaths, allowedPaths: [file], acceptanceCriteria: [`${file} combines the context text with ${value}`],
    verificationCommands: [['node', '-e', process.argv[3] === 'fail' ? 'process.exit(1)' : `const fs=require('fs');if(fs.readFileSync('${file}','utf8').trim()!=='context-marker ${value}')process.exit(1)`]]
  };
});
const settings = readUserSettings();
if (process.env.CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE !== 'trusted-local') {
  throw new Error('Set CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE=trusted-local explicitly to run the real integration smoke test.');
}
console.log(JSON.stringify({ root, stateRoot: process.env.CODEX_ANTIGRAVITY_STATE_ROOT, count, preferredModel: settings.model, maxWorkers: settings.maxWorkers }));
const submitted = await delegate(root, tasks, { maxParallel: Math.min(settings.maxWorkers, count), runMode: 'trusted-local', waitSeconds: 0 });
let update = submitted;
while (['queued', 'running'].includes(update.batchStatus)) {
  update = await waitForBatchChange(root, submitted.batchId, update.cursor, 20);
}
const report = await recover(root, submitted.batchId);
console.log(JSON.stringify(report));
if (!process.argv[3] && report.completed !== count) process.exitCode = 1;
if (process.argv[3] === 'high') {
  console.log(JSON.stringify({ beforeIntegration: fs.existsSync(path.join(root, 'result-1.txt')) }));
  console.log(JSON.stringify(await integrateTask(root, report.batchId, 'worker1')));
  console.log(JSON.stringify({ afterIntegration: fs.existsSync(path.join(root, 'result-1.txt')) }));
}
