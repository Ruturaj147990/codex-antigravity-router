import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

export class ExecutionUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'ExecutionUnavailableError'; }
}

export class TrustedLocalExecutionProvider {
  async capabilities() { return { mode: 'trusted-local', isolated: false, workspaceBound: true, capturesExitStatus: true }; }
  async run({ workspace, command, timeoutSeconds }) {
    if (!path.isAbsolute(workspace) || !fs.existsSync(workspace) || !Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) throw new Error('Invalid trusted-local command or workspace.');
    const cwd = fs.realpathSync.native(workspace);
    try {
      const { stdout, stderr } = await exec(command[0], command.slice(1), { cwd, windowsHide: true, shell: false, timeout: timeoutSeconds * 1000, maxBuffer: 2_000_000 });
      return { workspace, exitCode: 0, output: (stdout + stderr).slice(-2000) };
    } catch (error) {
      return { workspace, exitCode: Number.isInteger(error.code) ? error.code : 1, output: String(error.stderr || error.message).slice(-2000) };
    }
  }
}

export async function configuredExecutionProvider(mode = 'fail-closed') {
  if (mode === 'trusted-local') {
    if (process.env.CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE !== 'trusted-local') {
      throw new ExecutionUnavailableError('Trusted-local execution requires operator opt-in before launching Codex.');
    }
    return new TrustedLocalExecutionProvider();
  }
  if (mode !== 'fail-closed') throw new ExecutionUnavailableError('Unknown execution mode.');
  const modulePath = process.env.CODEX_ANTIGRAVITY_EXECUTION_PROVIDER;
  if (!modulePath) return new FailClosedExecutionProvider();
  if (!path.isAbsolute(modulePath)) throw new ExecutionUnavailableError('Execution provider path must be absolute.');
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createExecutionProvider !== 'function') throw new ExecutionUnavailableError('Execution provider must export createExecutionProvider().');
  return await requireIsolatedProvider(await module.createExecutionProvider());
}

export async function requireAuthorizedProvider(provider, mode) {
  const capabilities = await provider.capabilities();
  if (mode === 'trusted-local' && capabilities?.mode === 'trusted-local' && capabilities?.workspaceBound === true && capabilities?.capturesExitStatus === true) return provider;
  return requireIsolatedProvider(provider);
}

export class FailClosedExecutionProvider {
  async capabilities() { return { isolated: false, reason: 'No verified OS-level restricted runner is configured.' }; }
  async run() { throw new ExecutionUnavailableError('Untrusted verification is unavailable: no verified restricted runner.'); }
}

export async function requireIsolatedProvider(provider) {
  const capabilities = await provider.capabilities();
  if (capabilities?.isolated !== true || capabilities?.workspaceBound !== true || capabilities?.capturesExitStatus !== true) {
    throw new ExecutionUnavailableError(capabilities?.reason || 'Execution provider lacks verified isolation, workspace binding, or exit-status reporting.');
  }
  return provider;
}

// Explicitly authorized trusted-local mode uses normal user permissions.
