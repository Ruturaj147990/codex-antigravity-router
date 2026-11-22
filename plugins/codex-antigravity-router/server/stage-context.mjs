import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [workspace, ...sources] = process.argv.slice(2);
if (!workspace || !sources.length) {
  throw new Error('Usage: node stage-context.mjs <repository> <file> [<file> ...]');
}

const root = fs.realpathSync(workspace);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
if (fs.realpathSync(git('rev-parse', '--show-toplevel').trim()) !== root) {
  throw new Error('Choose the Git repository root.');
}

const inputs = sources.map((source) => {
  const file = fs.realpathSync(source);
  if (!fs.statSync(file).isFile()) throw new Error(`Expected a regular file: ${source}`);
  return file;
});
const folder = `router-context-${crypto.randomUUID()}`;
const contextPaths = inputs.map((source, index) => `${folder}/${index + 1}-${path.basename(source)}`);
for (const relative of contextPaths) {
  try {
    git('check-ignore', '-q', '--', relative);
    throw new Error(`Git ignores the proposed staging path: ${relative}`);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
}
fs.mkdirSync(path.join(root, folder));
for (const [index, source] of inputs.entries()) {
  fs.copyFileSync(source, path.join(root, contextPaths[index]), fs.constants.COPYFILE_EXCL);
}
console.log(JSON.stringify({ workspaceRoot: root, contextPaths }, null, 2));
