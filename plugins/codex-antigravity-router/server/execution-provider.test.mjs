import test from 'node:test';
import assert from 'node:assert/strict';
import { FailClosedExecutionProvider, TrustedLocalExecutionProvider, requireIsolatedProvider, requireAuthorizedProvider, verificationReadiness } from './execution-provider.mjs';
import { delegate } from './orchestrator.mjs';

test('production verification fails closed without a restricted runner', async () => {
  const provider = new FailClosedExecutionProvider();
  await assert.rejects(requireIsolatedProvider(provider), /No verified OS-level restricted runner/);
  await assert.rejects(provider.run(), /Untrusted verification is unavailable/);
});

test('verification readiness explains the trusted-local opt-in before Codex restart', async () => {
  const unavailable = await verificationReadiness({});
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.mode, 'fail-closed');
  assert.equal(unavailable.requiredOptIn, 'CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE');
  assert.match(unavailable.message, /set CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE=trusted-local before launching Codex and restart Codex/i);
  const trusted = await verificationReadiness({ CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE: 'trusted-local' });
  assert.equal(trusted.ready, true);
  assert.equal(trusted.mode, 'trusted-local');
  assert.equal(trusted.isolated, false);
  assert.match(trusted.message, /not sandboxed/i);
});

test('the controller rejects a runner missing security capabilities', async () => {
  const fake = { capabilities: async () => ({ isolated: true, workspaceBound: false, capturesExitStatus: true }), run: async () => ({ exitCode: 0 }) };
  await assert.rejects(requireIsolatedProvider(fake), /workspace binding/);
});

test('delegation refuses unconfined verification before starting a worker', async () => {
  const task = { id: 'test', title: 'Test', risk: 'LOW_RISK', instructions: 'Inspect and fix a controlled fixture.', allowedPaths: ['a.txt'], acceptanceCriteria: ['Check result'], verificationCommands: [['node', '--test']] };
  await assert.rejects(delegate('C:/does-not-matter', [task]), /No verified OS-level restricted runner/);
});

test('trusted-local executes an authorized command in its selected workspace', async () => {
  const provider = new TrustedLocalExecutionProvider();
  await requireAuthorizedProvider(provider, 'trusted-local');
  const result = await provider.run({ taskId: 'fixture', workspace: process.cwd(), command: ['node', '-e', 'process.stdout.write(process.cwd())'], timeoutSeconds: 10 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, process.cwd());
});

test('trusted-local preflights executables without substituting a missing runtime', async () => {
  const provider = new TrustedLocalExecutionProvider();
  const good = await provider.preflight({ workspace: process.cwd(), command: [process.execPath, '--version'] });
  assert.equal(good.available, true);
  const missing = await provider.preflight({ workspace: process.cwd(), command: ['codex-router-nonexistent-runtime-98765', 'script.py'] });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /not found on PATH/);
});

test('trusted-local keeps stdout and stderr separate when a check fails', async () => {
  const provider = new TrustedLocalExecutionProvider();
  const result = await provider.run({ workspace: process.cwd(), command: [process.execPath, '-e', 'console.log("assertion digest 1234"); console.error("diagnostic stderr"); process.exitCode=3'], timeoutSeconds: 10 });
  assert.equal(result.exitCode, 3);
  assert.match(result.stdoutTail, /digest 1234/);
  assert.match(result.stderrTail, /diagnostic stderr/);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
});

test('trusted-local preserves a failing check diagnostic written only to stdout', async () => {
  const provider = new TrustedLocalExecutionProvider();
  const result = await provider.run({ workspace: process.cwd(), command: [process.execPath, '-e',
    'console.log("starting checks ".repeat(300)); console.log("IntegrityError: run session does not belong to workspace"); process.exitCode = 1'], timeoutSeconds: 10 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderrTail, '');
  assert.match(result.stdoutTail, /IntegrityError: run session does not belong to workspace/);
});
