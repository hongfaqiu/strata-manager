import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// Strata update progress card: checks each backend phase maps to the right stage/outcome and saves
// screenshots (RUNTIME_UPDATE_SHOTS=<dir>, RUNTIME_UPDATE_PREFIX=new|current, RUNTIME_UPDATE_CASES=a,b:dark).
// Native IO is the synthetic fixture in runtime-update-progress-native-fixture.js; nothing is downloaded.
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const shots = process.env.RUNTIME_UPDATE_SHOTS || resolve(root, 'output/playwright/runtime-update-progress');
const prefix = process.env.RUNTIME_UPDATE_PREFIX || 'new';
await mkdir(shots, { recursive: true });
const cases = (process.env.RUNTIME_UPDATE_CASES || 'source,downloading,unknown,retry,extracting,verifying,applying,done,failed,rolledback,cancelled,downloading:dark,done:dark,downloading:en,downloading:narrow').split(',');
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
const errors = [], results = [];
const expected = { source: ['source', 'running'], downloading: ['download', 'running'], unknown: ['download', 'running'], retry: ['download', 'running'], extracting: ['extract', 'running'], verifying: ['extract', 'running'], applying: ['apply', 'running'], done: ['restore', 'completed'], failed: ['apply', 'failed'], rolledback: ['apply', 'failed'], cancelled: ['download', 'cancelled'] };
try {
  for (const item of cases) {
    const [scenario, variant] = item.split(':');
    const dark = variant === 'dark', en = variant === 'en', narrow = variant === 'narrow';
    const context = await browser.newContext({ viewport: { width: narrow ? 760 : 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(`${item}: ${error}`));
    await page.goto(`${origin}/runtime-update-progress-app.html?state=settings&update=${scenario}${dark ? '&theme=dark' : ''}${en ? '&lang=en' : ''}#environment`);
    const panel = page.locator('.runtime-management');
    await panel.waitFor();
    await page.waitForTimeout(['done', 'failed', 'rolledback', 'cancelled'].includes(scenario) ? 4500 : 3500);
    const card = page.getByTestId('runtime-update-progress');
    if (prefix !== 'current') {
      try {
        const [stage, outcome] = expected[scenario] ?? [];
        assert.equal(await card.getAttribute('data-stage'), stage, `${item} stage`);
        assert.equal(await card.getAttribute('data-outcome'), outcome, `${item} outcome`);
        const textContent = await card.innerText();
        assert.doesNotMatch(textContent, /\d{6,}/, `${item}: no raw byte counts`);
        assert.equal(await page.getByRole('dialog').count(), 0, `${item}: no automatic update prompt over the result`);
        if (outcome === 'running') assert.ok(await card.getByRole('button', { name: en ? 'Cancel update' : '取消更新' }).isVisible(), `${item}: cancel visible`);
        if (outcome === 'failed' || outcome === 'cancelled') assert.ok(await card.getByRole('button', { name: en ? 'Retry update' : '重试更新' }).isVisible(), `${item}: retry visible`);
        if (scenario === 'downloading') {
          assert.match(textContent, /\d+%/); assert.match(textContent, /MB\/s/); assert.match(textContent, en ? /left/ : /剩余约/);
          const before = await card.locator('.ru-bytes').innerText(); await page.waitForTimeout(2200);
          assert.notEqual(await card.locator('.ru-bytes').innerText(), before, 'bytes update live');
          await card.getByRole('button', { name: en ? /Task log/ : /任务日志/ }).click();
          assert.ok(await card.getByRole('log').isVisible());
          await card.getByRole('button', { name: en ? /Task log/ : /任务日志/ }).click();
        }
        if (scenario === 'unknown') { assert.doesNotMatch(textContent, /\d+%/); assert.match(textContent, en ? /total size unknown/ : /总大小未知/); }
        if (scenario === 'rolledback') assert.match(textContent, en ? /previous version was restored/ : /已恢复原版本/);
        if (narrow) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
        results.push(`PASS ${item}`);
      } catch (error) { results.push(`FAIL ${item}: ${error.message}`); process.exitCode = 1; }
    }
    if (process.env.RUNTIME_UPDATE_OPEN_LOG && scenario === 'retry') await page.locator('.runtime-management details summary').first().click().catch(() => {});
    await panel.scrollIntoViewIfNeeded();
    const box = await panel.boundingBox();
    const name = `${prefix}-${scenario}${variant ? `-${variant}` : ''}.png`;
    await page.screenshot({ path: resolve(shots, name), clip: { x: 0, y: Math.max(0, box.y - 16), width: page.viewportSize().width, height: Math.min(900 - Math.max(0, box.y - 16), box.height + 32) } }).catch(async () => page.screenshot({ path: resolve(shots, name), fullPage: true }));
    console.log(results.at(-1) ?? '', 'saved', name);
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
console.log(`${results.filter(line => line.startsWith('PASS')).length}/${results.length} passed`);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
