#!/usr/bin/env node
/** Headless Chrome screenshots for issue #6 server Web panel (light theme). */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SHOT_DIR || '/workspace/screenshots/issue-6';
const dataDir = process.env.STRATA_MANAGER_DATA_DIR || '/tmp/sm6-shot-data';
const webRoot = process.env.STRATA_MANAGER_WEB_ROOT || path.join(root, 'apps/desktop/dist');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
    });
    s.on('error', reject);
  });
}

function run(cmd, args, env) {
  return spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitHealth(base, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/v1/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server health timeout');
}

async function loadPuppeteer() {
  const candidates = [
    path.join(root, 'node_modules/puppeteer'),
    '/tmp/sm6-cap/node_modules/puppeteer',
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return (await import(pathToFileURL(path.join(dir, 'lib/esm/puppeteer/puppeteer.js')).href)).default;
    }
  }
  const require = createRequire(import.meta.url);
  try {
    return require('/tmp/sm6-cap/node_modules/puppeteer');
  } catch {
    throw new Error('puppeteer not found; npm install puppeteer in /tmp/sm6-cap');
  }
}

const port = await freePort();
const bind = `127.0.0.1:${port}`;
await mkdir(dataDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const binCandidates = [
  path.join(root, 'target/debug/strata-manager-server'),
  path.join(root, 'target/release/strata-manager-server'),
  path.join(root, 'apps/desktop/src-tauri/target/debug/strata-manager-server'),
];
const bin = binCandidates.find(existsSync);
if (!bin) throw new Error('strata-manager-server binary not found; build first');

const child = run(bin, [], {
  STRATA_MANAGER_BIND: bind,
  STRATA_MANAGER_DATA_DIR: dataDir,
  STRATA_MANAGER_WEB_ROOT: webRoot,
});
child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));

const base = `http://${bind}`;
try {
  await waitHealth(base);
  const token = (await readFile(path.join(dataDir, 'server-token'), 'utf8')).trim();
  await fetch(`${base}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      method: 'store_set',
      params: {
        key: 'settings',
        value: {
          language: 'zh-CN',
          theme: 'light',
          pollInterval: 5000,
          closeToTray: false,
          autoCheckUpdates: false,
        },
      },
    }),
  });

  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,960'],
    defaultViewport: { width: 1440, height: 960 },
  });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle0', timeout: 180000 });
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: path.join(outDir, '01-overview-light.png') });
  await page.evaluate(() => { location.hash = '#models'; });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '02-models-light.png') });
  await page.evaluate(() => { location.hash = '#tasks'; });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '03-tasks-logs-light.png') });
  await page.evaluate(() => { location.hash = '#config'; });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '05-config-restart-badge.png') });
  await page.evaluate(() => { location.hash = '#settings'; });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(outDir, '04-settings-light.png') });
  await page.evaluate(() => sessionStorage.removeItem('strata-manager-server-token'));
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: path.join(outDir, '00-auth-gate-light.png') });
  await browser.close();
  await writeFile(path.join(outDir, 'README.txt'), `Issue #6 light-theme screenshots\nbase=${base}\n`, 'utf8');
  console.log('shots written to', outDir);
} finally {
  child.kill('SIGTERM');
}
