import test from 'node:test';
import assert from 'node:assert/strict';
import { FailClosedExecutionProvider, TrustedLocalExecutionProvider, requireIsolatedProvider, requireAuthorizedProvider } from './execution-provider.mjs';
import { delegate } from './orchestrator.mjs';

test('production verification fails closed without a restricted runner', async () => {
  const provider = new FailClosedExecutionProvider();
  await assert.rejects(requireIsolatedProvider(provider), /No verified OS-level restricted runner/);
  await assert.rejects(provider.run(), /Untrusted verification is unavailable/);
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
