import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { availableModels, dashboardAgents, requestStopAllWorkers } from './orchestrator.mjs';
import { MAX_WORKERS_LIMIT, readUserSettings, validatePreferredModel, writeUserSettings } from './settings.mjs';
import { verificationReadiness } from './execution-provider.mjs';

const htmlPath = fileURLToPath(new URL('./dashboard-browser.html', import.meta.url));
const equalSecret = (left, right) => {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Settings request is too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Settings request must contain valid JSON.'); }
}

export async function createDashboardServer({ host = '127.0.0.1', port = 0, token = crypto.randomBytes(32).toString('hex'), models = availableModels, agents = dashboardAgents, settings = readUserSettings, saveSettings = writeUserSettings, stopWorkers = requestStopAllWorkers, verification = verificationReadiness } = {}) {
  if (host !== '127.0.0.1') throw new Error('The browser dashboard must bind to 127.0.0.1 only.');
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${host}:${server.address().port}`;
      if (req.headers.host !== `${host}:${server.address().port}`) return send(res, 421, { error: 'Use the dashboard link on this computer.' });
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Cross-origin dashboard requests are blocked.' });
      const url = new URL(req.url || '/', origin);
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 204, '');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(htmlPath, 'utf8'), 'text/html; charset=utf-8');
      if (!['/api/dashboard', '/api/settings'].includes(url.pathname)) return send(res, 404, { error: 'Not found.' });
      if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return send(res, 401, { error: 'Dashboard link expired or missing its local access token.' });
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        return send(res, 200, { settings: settings(), models: await models(), agents: agents(), verification: await verification(), updatedAt: new Date().toISOString() });
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Settings must be submitted as JSON.' });
        const input = await readJson(req), model = validatePreferredModel(input.model, 'model');
        if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.maxWorkers) || input.maxWorkers < 1 || input.maxWorkers > MAX_WORKERS_LIMIT) return send(res, 400, { error: `Choose delegation on or off and a whole worker limit from 1 to ${MAX_WORKERS_LIMIT}.` });
        const persisted = saveSettings({ enabled: input.enabled, maxWorkers: input.maxWorkers, model });
        const stoppedWorkers = input.enabled ? 0 : stopWorkers('Delegation disabled in the router dashboard.');
        return send(res, 200, { ...persisted, stoppedWorkers, message: input.enabled ? 'Settings saved.' : `Delegation disabled; cancellation requested for ${stoppedWorkers} active worker(s).` });
      }
      return send(res, 405, { error: 'Method not allowed.' });
    } catch (error) { return send(res, 400, { error: error.message || 'Dashboard request failed.' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port, baseUrl = `http://${host}:${actualPort}/`;
  return { server, host, port: actualPort, token, baseUrl, url: `${baseUrl}#token=${encodeURIComponent(token)}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

let activeDashboard, reopening;
async function reachable(dashboard) {
  if (!dashboard?.server.listening) return false;
  return new Promise((resolve) => {
    const request = http.get(new URL('/health', dashboard.baseUrl), (response) => {
      response.resume();
      resolve(response.statusCode === 204);
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}
export async function openBrowserDashboard() {
  reopening ??= (async () => {
    let verifiedReachable = await reachable(activeDashboard);
    if (!verifiedReachable) {
      await closeBrowserDashboard();
      activeDashboard = await createDashboardServer();
      verifiedReachable = await reachable(activeDashboard);
    }
    const { url, host, port, baseUrl, server } = activeDashboard;
    return { url, host, port, baseUrl, listening: server.listening, browserOpened: false, verifiedReachable };
  })().finally(() => { reopening = undefined; });
  return reopening;
}
export async function closeBrowserDashboard() {
  const current = activeDashboard;
  activeDashboard = undefined;
  if (current?.server.listening) await current.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dashboard = await openBrowserDashboard();
  // Interactive output is the handoff to the operator. Never print the private link to redirected logs.
  if (process.stdout.isTTY) process.stdout.write(`Open this private dashboard link: ${dashboard.url}\n`);
}
