import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MAX_WORKERS, DEFAULT_MODEL, MAX_WORKERS_LIMIT, readUserSettings, writeUserSettings } from './settings.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'router-settings-test-')); }

test('settings use environment defaults and retain backward compatibility', (t) => {
  const root = home();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readUserSettings({ home: root, env: {} }), {
    model: DEFAULT_MODEL,
    maxWorkers: DEFAULT_MAX_WORKERS,
    settingsFile: path.join(root, '.codex', 'antigravity-router', 'settings.json'),
    enabled: true
  });
  const settings = readUserSettings({ home: root, env: {
    CODEX_HOME: root,
    CODEX_ANTIGRAVITY_MODEL: 'gemini-3.8-flash-medium',
    CODEX_ANTIGRAVITY_DEFAULT_MAX_PARALLEL: '6'
  } });
  assert.equal(settings.model, 'gemini-3.8-flash-medium');
  assert.equal(settings.maxWorkers, 6);
});

test('user settings file overrides package defaults and can set six workers', (t) => {
  const root = home();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'antigravity-router');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-4-6', maxWorkers: 6 }));
  const settings = readUserSettings({ env: { CODEX_HOME: root, CODEX_ANTIGRAVITY_MODEL: DEFAULT_MODEL, CODEX_ANTIGRAVITY_MAX_WORKERS: '4' } });
  assert.equal(settings.model, 'claude-sonnet-4-6');
  assert.equal(settings.maxWorkers, 6);
  assert.equal(settings.settingsFile, path.join(folder, 'settings.json'));
  fs.writeFileSync(path.join(folder, 'settings.json'), '\uFEFF{"model":"claude-sonnet-4-6","maxWorkers":6}');
  assert.equal(readUserSettings({ env: { CODEX_HOME: root } }).maxWorkers, 6);
  const saved = writeUserSettings({ enabled: false, maxWorkers: 3, model: 'gemini-3.8-flash-low' }, { env: { CODEX_HOME: root } });
  assert.equal(saved.enabled, false);
  assert.equal(readUserSettings({ env: { CODEX_HOME: root } }).enabled, false);
  assert.throws(() => writeUserSettings({ enabled: 'false' }, { env: { CODEX_HOME: root } }), /settings.enabled must be a boolean/);
});

test('settings reject invalid JSON, unknown fields, invalid models, and worker limits', (t) => {
  const root = home();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'antigravity-router');
  fs.mkdirSync(folder);
  const settingsFile = path.join(folder, 'settings.json');
  const env = { CODEX_HOME: root };
  const invalid = [
    ['{', /Cannot read Antigravity router settings/],
    ['[]', /Cannot read Antigravity router settings/],
    ['{"maxWorker":6}', /Cannot read Antigravity router settings/],
    ['{"model":""}', /Preferred model must be/],
    ['{"model":null}', /Preferred model must be/],
    ['{"enabled":"false"}', /settings.enabled must be a boolean/],
    ['{"maxWorkers":0}', /settings\.maxWorkers must be/],
    ['{"maxWorkers":1.5}', /settings\.maxWorkers must be/],
    [`{"maxWorkers":${MAX_WORKERS_LIMIT + 1}}`, /settings\.maxWorkers must be/]
  ];
  for (const [content, expected] of invalid) {
    fs.writeFileSync(settingsFile, content);
    assert.throws(() => readUserSettings({ env }), expected);
  }
  assert.throws(() => readUserSettings({ env: { CODEX_HOME: root, CODEX_ANTIGRAVITY_SETTINGS_FILE: 'relative.json' } }), /must be an absolute path/);
  assert.throws(() => readUserSettings({ env: { CODEX_HOME: root, CODEX_ANTIGRAVITY_MAX_WORKERS: 'NaN' } }), /integer from 1 to 32/);
});
