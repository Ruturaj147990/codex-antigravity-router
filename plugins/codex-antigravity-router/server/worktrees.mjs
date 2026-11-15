import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const canonical = (p) => fs.realpathSync.native(p);
export const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export const within = (root, p) => { const r = path.relative(root, p); return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
export const hash = (p) => {
  let fd;
  try {
    const s = fs.lstatSync(p); if (!s.isFile()) return `type:${s.mode}`;
    const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    fd = fs.openSync(p, 'r');
    let position = 0;
    while (position < s.size) { const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, s.size - position), position); if (!count) break; digest.update(buffer.subarray(0, count)); position += count; }
    if (position !== s.size) throw new Error(`File changed while hashing: ${p}`);
    return digest.digest('hex');
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
};
export async function git(cwd, ...args) { const { stdout } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); return stdout; }
export function globalRoot() { return process.env.CODEX_ANTIGRAVITY_STATE_ROOT || path.join(os.homedir(), '.codex', 'antigravity-managed'); }
export function stateRoot(root) { const id = crypto.createHash('sha256').update(key(canonical(root))).digest('hex').slice(0, 20); return path.join(globalRoot(), id); }
export function persist(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; const fd = fs.openSync(tmp, 'wx'); try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, file); }
export function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function acquire(root) { fs.mkdirSync(root, { recursive: true }); const file = path.join(root, 'controller.lock'); try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; const old = JSON.parse(fs.readFileSync(file, 'utf8')); try { process.kill(old.pid, 0); throw new Error(`A router controller is active (PID ${old.pid}).`); } catch (x) { if (x.code !== 'ESRCH') throw x; } fs.renameSync(file, `${file}.stale.${Date.now()}`); fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' }); } return () => { try { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); if (owner.pid === process.pid) fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }; }
export function paths(raw) { return raw.split('\0').filter(Boolean).map((p) => p.replaceAll('\\', '/')); }
async function apply(cwd, patch) { if (!patch) return; await new Promise((resolve, reject) => { const child = spawn('git', ['apply', '--binary', '--whitespace=nowarn', '-'], { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }); let err = ''; child.stderr.on('data', (c) => { err += c; }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Could not overlay user changes: ${err}`))); child.stdin.end(patch); }); }
export async function snapshot(root) { const base = (await git(root, 'rev-parse', 'HEAD')).trim(); const patch = await git(root, 'diff', 'HEAD', '--binary', '--no-ext-diff'); const untracked = paths(await git(root, 'ls-files', '--others', '--exclude-standard', '-z')); const tracked = paths(await git(root, 'ls-files', '-z')); const files = {}; for (const p of new Set([...tracked, ...untracked])) { try { files[p] = hash(path.join(root, p)); } catch (e) { throw new Error(`Snapshot preparation failed at relative path ${p} (${e.code || e.name || 'I/O error'}).`); } } return { base, patch, untracked, files }; }
export async function managedCheckout(root, batchId, index) { const base = path.join(root, '.ag'); const marker = path.join(base, 'managed.json'); if (fs.existsSync(base) && !fs.existsSync(marker)) throw new Error(`Reserved worker directory already exists without a management marker: ${base}`); fs.mkdirSync(base, { recursive: true }); if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ root: canonical(root), purpose: 'temporary Antigravity Git worktrees' })); const owner = JSON.parse(fs.readFileSync(marker, 'utf8')); if (key(owner.root) !== key(canonical(root))) throw new Error('Managed worker directory belongs to another repository.'); const excludeRaw = (await git(root, 'rev-parse', '--git-path', 'info/exclude')).trim(); const exclude = path.isAbsolute(excludeRaw) ? excludeRaw : path.join(root, excludeRaw); const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''; if (!current.split(/\r?\n/).includes('/.ag/')) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}/.ag/\n`); } return path.join(base, batchId.slice(0, 8), `w${index + 1}`); }
export async function createWorker(root, folder, taskId, snap, workerPath) { const worker = workerPath || path.join(folder, taskId); if (fs.existsSync(worker)) throw new Error(`Worker path already exists: ${worker}`); await git(root, 'worktree', 'add', '--detach', worker, snap.base); try { await apply(worker, snap.patch); for (const [p, value] of Object.entries(snap.files)) { const source = path.join(root, p), target = path.join(worker, p); if (hash(source) !== value) throw new Error(`Authoritative file changed during snapshot: ${p}`); if (hash(target) === value) continue; if (value === null) { if (fs.existsSync(target)) fs.unlinkSync(target); } else { if (!fs.lstatSync(source).isFile()) throw new Error(`Unsupported source entry: ${p}`); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); } } const actual = key(canonical((await git(worker, 'rev-parse', '--show-toplevel')).trim())); if (actual !== key(canonical(worker))) throw new Error('Git worktree identity mismatch.'); for (const [p, value] of Object.entries(snap.files)) if (hash(path.join(worker, p)) !== value) throw new Error(`Snapshot mismatch: ${p}`); return worker; } catch (e) { throw new Error(`Worker preserved at ${worker}; preparation failed: ${e.message}`); } }
export async function changed(worker, snap) { const tracked = paths(await git(worker, 'ls-files', '-z')); const untracked = paths(await git(worker, 'ls-files', '--others', '--exclude-standard', '-z')); const result = []; for (const p of new Set([...Object.keys(snap.files), ...tracked, ...untracked])) if (hash(path.join(worker, p)) !== (snap.files[p] ?? null)) result.push(p); return result.sort(); }
export function safeFile(root, relative) { if (relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Unsafe path: ${relative}`); const target = path.resolve(root, relative); if (!within(root, target)) throw new Error(`Path escapes workspace: ${relative}`); let current = path.dirname(target); while (within(root, current) && fs.existsSync(current)) { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path: ${relative}`); if (key(current) === key(root)) break; current = path.dirname(current); } if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Symlink target: ${relative}`); return target; }
export async function integrate(root, worker, snap, files) { const conflicts = files.filter((p) => hash(safeFile(root, p)) !== (snap.files[p] ?? null)); if (conflicts.length) return { integrated: false, conflicts }; for (const p of files) { const source = safeFile(worker, p), dest = safeFile(root, p); if (fs.existsSync(source)) { if (!fs.lstatSync(source).isFile()) throw new Error(`Unsupported worker output: ${p}`); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest); } else if (fs.existsSync(dest)) fs.unlinkSync(dest); } return { integrated: true, conflicts: [] }; }
export async function disposeWorker(root, worker, snap) {
  const changedFiles = await changed(worker, snap);
  const inventory = [];
  const walk = (dir, prefix = '') => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { if (!prefix && item.name === '.git') continue; const rel = prefix ? `${prefix}/${item.name}` : item.name; const full = path.join(dir, item.name); if (item.isDirectory()) walk(full, rel); else inventory.push(rel); } };
  walk(worker);
  const compared = new Set([...changedFiles, ...inventory]);
  const unaccounted = [...compared].filter((p) => hash(path.join(root, p)) !== hash(path.join(worker, p)));
  if (unaccounted.length) return { disposed: false, reason: 'Worker has tracked, untracked, or ignored content not preserved in the authoritative workspace.', unaccounted };
  walk(worker);
  const finalDifferences = [...new Set(inventory)].filter((p) => hash(path.join(root, p)) !== hash(path.join(worker, p)));
  if (finalDifferences.length) return { disposed: false, reason: 'Workspace changed during disposition check.', unaccounted: finalDifferences };
  await git(root, 'worktree', 'remove', '--force', worker);
  return { disposed: true };
}
