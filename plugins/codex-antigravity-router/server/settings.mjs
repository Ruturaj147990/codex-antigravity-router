import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MODEL = 'gemini-3.8-flash-low';
export const DEFAULT_MAX_WORKERS = 4;
export const MAX_WORKERS_LIMIT = 32;

export function validatePreferredModel(value, source = 'Preferred model') {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw new Error(`${source} must be a non-empty model name of at most 128 characters.`);
  }
  return value.trim();
}

function validWorkerCount(value, source) {
  const count = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_WORKERS_LIMIT) {
    throw new Error(`${source} must be an integer from 1 to ${MAX_WORKERS_LIMIT}.`);
  }
  return count;
}

export function readUserSettings({ env = process.env, home = os.homedir() } = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const override = env.CODEX_ANTIGRAVITY_SETTINGS_FILE;
  if (override && !path.isAbsolute(override)) throw new Error('CODEX_ANTIGRAVITY_SETTINGS_FILE must be an absolute path.');
  const settingsFile = path.resolve(override || path.join(codexHome, 'antigravity-router', 'settings.json'));

  let fileSettings = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Settings must be a JSON object.');
    const unknown = Object.keys(parsed).filter((key) => !['model', 'maxWorkers', 'enabled'].includes(key));
    if (unknown.length) throw new Error(`Unknown settings: ${unknown.join(', ')}.`);
    fileSettings = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read Antigravity router settings at ${settingsFile}: ${error.message}`);
  }

  const modelValue = fileSettings.model !== undefined ? fileSettings.model : env.CODEX_ANTIGRAVITY_MODEL ?? DEFAULT_MODEL;
  const model = validatePreferredModel(modelValue, 'Preferred model');
  const envWorkers = env.CODEX_ANTIGRAVITY_MAX_WORKERS ?? env.CODEX_ANTIGRAVITY_DEFAULT_MAX_PARALLEL;
  const maxWorkers = fileSettings.maxWorkers !== undefined
    ? validWorkerCount(fileSettings.maxWorkers, 'settings.maxWorkers')
    : envWorkers !== undefined
      ? validWorkerCount(envWorkers, 'CODEX_ANTIGRAVITY_MAX_WORKERS')
      : DEFAULT_MAX_WORKERS;
  const enabled = fileSettings.enabled === undefined ? true : fileSettings.enabled;
  if (typeof enabled !== 'boolean') throw new Error('settings.enabled must be a boolean.');
  return { model, maxWorkers, settingsFile, enabled };
}

export function writeUserSettings(patch, { env = process.env } = {}) {
  const current = readUserSettings({ env });
  const next = { model: current.model, maxWorkers: current.maxWorkers, enabled: current.enabled, ...patch };
  const model = validatePreferredModel(next.model);
  const maxWorkers = validWorkerCount(next.maxWorkers, 'settings.maxWorkers');
  if (typeof next.enabled !== 'boolean') throw new Error('settings.enabled must be a boolean.');
  const file = current.settingsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ model, maxWorkers, enabled: next.enabled }, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, file);
  return { model, maxWorkers, enabled: next.enabled, settingsFile: file };
}
