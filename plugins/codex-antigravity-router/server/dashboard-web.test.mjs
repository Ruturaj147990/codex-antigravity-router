import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeBrowserDashboard, createDashboardServer, openBrowserDashboard } from './dashboard-web.mjs';

test('browser dashboard serves settings and agent data and saves validated preferences', async (t) => {
  let current = { enabled: true, maxWorkers: 4, model: 'gemini-3.8-flash-low' }, stopCount = 0;
  const dashboard = await createDashboardServer({
    token: 'test-secret',
    models: async () => ['gemini-3.8-flash-low', 'gemini-3.8-flash-high'],
    agents: () => [{ name: 'Worker demo', task: 'Add demo output', phase: 'running', live: true, workspace: 'demo', model: current.model }],
    verification: async () => ({ ready: false, mode: 'fail-closed', requiredOptIn: 'CODEX_ANTIGRAVITY_DEFAULT_RUN_MODE', message: 'Verification unavailable; restart Codex after trusted-local opt-in.' }),
    settings: () => current,
    saveSettings: (patch) => { current = { ...current, ...patch }; return current; },
    stopWorkers: () => { stopCount++; return 2; }
  });
  t.after(() => dashboard.close());
  const base = dashboard.baseUrl, headers = { authorization: 'Bearer test-secret' };
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Preferred Antigravity model/);
  assert.equal((await fetch(`${base}api/dashboard`)).status, 401);
  const data = await (await fetch(`${base}api/dashboard`, { headers })).json();
  assert.deepEqual(data.models, ['gemini-3.8-flash-low', 'gemini-3.8-flash-high']);
  assert.equal(data.agents[0].name, 'Worker demo');
  assert.equal(data.verification.ready, false);
  assert.match(data.verification.message, /restart Codex/);
  const update = await fetch(`${base}api/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, maxWorkers: 6, model: 'gemini-3.8-flash-high' }) });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).stoppedWorkers, 2);
  assert.deepEqual(current, { enabled: false, maxWorkers: 6, model: 'gemini-3.8-flash-high' });
  assert.equal(stopCount, 1);
  const invalid = await fetch(`${base}api/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, maxWorkers: 33, model: 'gemini-3.8-flash-low' }) });
  assert.equal(invalid.status, 400);
  const crossOrigin = await fetch(`${base}api/dashboard`, { headers: { ...headers, origin: 'http://example.com' } });
  assert.equal(crossOrigin.status, 403);
});

test('browser dashboard refuses non-loopback binding and inline script parses', async () => {
  await assert.rejects(createDashboardServer({ host: '0.0.0.0' }), /127\.0\.0\.1 only/);
  const html = fs.readFileSync(new URL('./dashboard-browser.html', import.meta.url), 'utf8');
  const start = html.indexOf('<script>'), end = html.indexOf('</script>', start);
  assert.notEqual(start, -1); assert.ok(end > start);
  new Function(html.slice(start + '<script>'.length, end));
});

test('plugin dashboard entry point returns a temporary loopback browser link', async (t) => {
  t.after(() => closeBrowserDashboard());
  const link = await openBrowserDashboard();
  assert.equal(link.host, '127.0.0.1');
  assert.ok(link.port > 0);
  assert.match(link.url, new RegExp(`^http://127\\.0\\.0\\.1:${link.port}/#token=[a-f0-9]{64}$`));
  const response = await fetch(link.baseUrl || `http://127.0.0.1:${link.port}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Antigravity Router/);
  assert.match(html, /Verification readiness/);
  assert.equal(link.listening, true);
  assert.equal(link.verifiedReachable, true);
  assert.equal(link.browserOpened, false);
  assert.equal((await openBrowserDashboard()).url, link.url);
  await closeBrowserDashboard();
  await assert.rejects(fetch(link.baseUrl));
  const reopened = await openBrowserDashboard();
  assert.notEqual(reopened.url, link.url);
  assert.equal(reopened.verifiedReachable, true);
});
