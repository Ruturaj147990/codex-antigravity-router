import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];

if (!output || !path.isAbsolute(output) || path.extname(output).toLowerCase() !== '.zip') {
  console.error('Usage: node server/package-directory.mjs <absolute-output.zip>');
  process.exit(2);
}
if (fs.existsSync(output)) {
  console.error(`Refusing to overwrite existing output: ${output}`);
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error('This packaging helper uses Windows PowerShell Compress-Archive.');
  process.exit(2);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-antigravity-router-directory-'));
try {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (entry.name === 'hooks') continue;
    fs.cpSync(path.join(pluginRoot, entry.name), path.join(staging, entry.name), { recursive: true });
  }

  const manifestPath = path.join(staging, 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.extensions?.['com.openai']?.hooks;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  execFileSync('tar.exe', ['-a', '-c', '-f', output, '-C', staging, '.'], { stdio: 'pipe' });
  console.log(`Created hook-free Plugins Directory package: ${output}`);
} catch (error) {
  if (fs.existsSync(output)) fs.rmSync(output, { force: true });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
