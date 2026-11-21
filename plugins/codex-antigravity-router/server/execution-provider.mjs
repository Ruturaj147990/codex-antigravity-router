import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const tail = (value, limit = 4000) => String(value || '').slice(-limit);

export class ExecutionUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'ExecutionUnavailableError'; }
}

export class TrustedLocalExecutionProvider {
  async capabilities() { return { mode: 'trusted-local', isolated: false, workspaceBound: true, capturesExitStatus: true }; }
  async preflight({ workspace, command }) {
    const cwd = fs.realpathSync.native(workspace), executable = command[0];
    const isPath = path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\');
    if (isPath) {
      const candidate = path.isAbsolute(executable) ? executable : path.resolve(cwd, executable);
      if (!fs.existsSync(candidate)) return { workspace, available: false, reason: `Executable not found: ${path.relative(cwd, candidate) || path.basename(candidate)}` };
    } else {
      const resolver = process.platform === 'win32' ? 'where.exe' : 'which';
      try { await exec(resolver, [executable], { cwd, windowsHide: true, timeout: 5000, maxBuffer: 20000 }); }
      catch { return { workspace, available: false, reason: `Executable not found on PATH: ${executable}` }; }
    }
    // The Windows Python launcher can exist while the explicitly requested version does not.
    if (process.platform === 'win32' && /^(?:py|py\.exe)$/i.test(path.basename(executable)) && /^-\d+(?:\.\d+)?$/.test(command[1] || '')) {
      try { await exec(executable, [command[1], '--version'], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 20000 }); }
      catch { return { workspace, available: false, reason: `Requested Python runtime ${command[1]} is unavailable; no interpreter was substituted.` }; }
    }
    return { workspace, available: true };
  }
  async run({ workspace, command, timeoutSeconds }) {
    if (!path.isAbsolute(workspace) || !fs.existsSync(workspace) || !Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) throw new Error('Invalid trusted-local command or workspace.');
    const cwd = fs.realpathSync.native(workspace);
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await exec(command[0], command.slice(1), { cwd, windowsHide: true, shell: false, timeout: timeoutSeconds * 1000, maxBuffer: 2_000_000 });
      const stdoutTail = tail(stdout), stderrTail = tail(stderr);
      return { workspace, exitCode: 0, timedOut: false, durationMs: Date.now() - startedAt, stdoutTail, stderrTail, output: tail(`${stdoutTail}${stderrTail}`, 2000) };
    } catch (error) {
      const stdoutTail = tail(error.stdout), stderrTail = tail(error.stderr), timedOut = error.code === 'ETIMEDOUT' || error.killed === true;
      return { workspace, exitCode: Number.isInteger(error.code) ? error.code : 1, timedOut, durationMs: Date.now() - startedAt, stdoutTail, stderrTail, output: tail(`${stdoutTail}${stderrTail || error.message || ''}`, 2000) };
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

export async function verificationReadiness(env = process.env) {
  const optInVariable = 'CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE';
  if (env[optInVariable] === 'trusted-local') {
    return { ready: true, mode: 'trusted-local', isolated: false, message: 'Ready: trusted-local checks run with the normal Windows user permissions; they are not sandboxed.' };
  }
  const modulePath = env.CODEX_ANTIGRAVITY_EXECUTION_PROVIDER;
  if (!modulePath) {
    return {
      ready: false, mode: 'fail-closed', isolated: false, requiredOptIn: optInVariable,
      reason: 'No verified restricted execution provider is configured.',
      message: `Verification is unavailable. Configure a restricted provider, or set ${optInVariable}=trusted-local before launching Codex and restart Codex. Trusted-local checks use normal Windows user permissions and are not sandboxed.`
    };
  }
  if (!path.isAbsolute(modulePath)) {
    return { ready: false, mode: 'fail-closed', isolated: false, reason: 'Execution provider path must be absolute.', message: 'Verification is unavailable because the configured execution provider path is not absolute.' };
  }
  try {
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.createExecutionProvider !== 'function') throw new ExecutionUnavailableError('Execution provider must export createExecutionProvider().');
    await requireIsolatedProvider(await module.createExecutionProvider());
    return { ready: true, mode: 'restricted', isolated: true, message: 'Ready: the configured restricted verification provider passed its capability checks.' };
  } catch (error) {
    return { ready: false, mode: 'fail-closed', isolated: false, reason: error.message, message: `Verification is unavailable: ${error.message}` };
  }
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
