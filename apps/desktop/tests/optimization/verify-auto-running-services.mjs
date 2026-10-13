import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as socketServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const port = await new Promise((resolve, reject) => { const server = socketServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const origin = `http://127.0.0.1:${port}`, output = resolve(root, 'output/playwright/auto-running-services');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
const results = [];
async function run(name, mode, action) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(10000);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(`${origin}/auto-running-services-app.html?mode=${mode}#models`);
    await page.locator('.desktop-app-frame').waitFor();
    await page.waitForFunction(() => window.__fixture.autoRunning.connectCalls === 1);
    await action(page);
    assert.deepEqual(errors, []);
    const evidence = await page.evaluate(() => ({ calls: window.__fixture.calls, forbidden: window.__fixture.autoRunning.forbidden, connected: window.__fixture.autoRunning.connected, activeProfile: window.__fixture.store.activeProfile }));
    assert.equal(evidence.calls.filter(call => call.command === 'connect_running_service').length, 1);
    assert.deepEqual(evidence.forbidden, []);
    assert.equal(evidence.calls.some(call => /^(import_local|switch_local_service|ensure_local_service|start_service|restart_service|stop_service|take_over_service)$/.test(call.command)), false);
    assert.equal(evidence.calls.some(call => call.command === 'strata_request' && call.args.method !== 'GET'), false);
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    const { calls, ...state } = evidence;
    results.push({ name, passed: true, ...state, connectCalls: 1, commands: calls.map(call => call.command) });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), pageErrors: errors, evidence: await page.evaluate(() => window.__fixture?.autoRunning) });
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    console.log(`FAIL ${name}: ${error}`);
  } finally { await context.close(); }
}
try {
  await run('existing-owner-connected-once-and-selected', 'owned', async page => {
    const current = page.locator('.service-manager-card.is-current[data-profile-id="fixture-actual"]');
    await current.waitFor();
    await current.getByRole('button', { name: '聊天', exact: true }).waitFor();
    assert.equal(await current.getByRole('button', { name: '停止', exact: true }).isEnabled(), true);
    await page.locator('.running-services-panel').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__fixture.store.activeProfile === 'fixture-actual');
    const pill = await page.locator('#pill-text').innerText();
    assert.doesNotMatch(pill, /未启动|检测到运行中服务/);
    assert.equal(await page.evaluate(() => window.__fixture.autoRunning.connected), true);
    await page.evaluate(() => window.__query.invalidateQueries());
    assert.equal(await page.evaluate(() => window.__fixture.autoRunning.connectCalls), 1);
  });
  await run('unverified-owner-preserves-instance-and-manual-controls', 'unverified', async page => {
    await page.getByText('隔离夹具：无法核验管理后台身份', { exact: true }).waitFor();
    const panel = page.locator('.running-services-panel');
    await panel.waitFor();
    assert.equal(await panel.getByRole('button', { name: '连接管理后台', exact: true }).isEnabled(), true);
    assert.equal(await panel.getByRole('button', { name: '托管此服务', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#pill-text').innerText(), '检测到运行中服务');
    await page.evaluate(() => window.__query.invalidateQueries());
    assert.equal(await page.evaluate(() => window.__fixture.autoRunning.connectCalls), 1);
  });
  await run('unloaded-external-service-never-auto-loads-or-migrates', 'unloaded', async page => {
    await page.waitForFunction(() => window.__fixture.calls.filter(call => call.command === 'strata_request' && call.args.path === '/health').length >= 2);
    const panel = page.locator('.running-services-panel');
    await panel.waitFor();
    assert.equal(await panel.locator('.running-service-heading .badge').innerText(), '模型未加载');
    assert.equal(await panel.locator('h3').innerText(), 'fixture-running-model');
    assert.equal(await panel.getByRole('button', { name: '连接管理后台', exact: true }).isEnabled(), true);
    assert.equal(await panel.getByRole('button', { name: '托管此服务', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#pill-text').innerText(), '检测到运行中服务');
    await page.evaluate(() => window.__query.invalidateQueries());
    assert.equal(await page.evaluate(() => window.__fixture.autoRunning.connectCalls), 1);
  });
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ scope: 'Full React App integration with in-memory synthetic native IO. No real services, ports or GPU.', results }, null, 2));
  await browser.close(); await server.close();
}
if (results.some(result => !result.passed)) process.exitCode = 1;
