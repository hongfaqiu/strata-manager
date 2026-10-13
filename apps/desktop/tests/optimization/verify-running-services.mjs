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
const origin = `http://127.0.0.1:${port}`, output = resolve(root, 'output/playwright/running-services');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
const results = [];
async function run(name, action, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1366, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(10000);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(`${origin}/running-services-app.html?language=${options.language ?? 'zh-CN'}`);
    await page.waitForFunction(() => window.__runningFixture.calls.some(call => call.args.path === '/health'));
    await action(page);
    assert.deepEqual(errors, []);
    const calls = await page.evaluate(() => window.__runningFixture.calls);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every(call => call.command === 'strata_request' && call.args.path === '/health' && call.args.method === 'GET' && call.args.profile.managed === false));
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    results.push({ name, passed: true, healthReads: calls.length });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), pageErrors: errors });
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    console.log(`FAIL ${name}: ${error}`);
  } finally { await context.close(); }
}
try {
  await run('unloaded-service-identity-and-read-only-detection', async page => {
    assert.equal(await page.locator('.running-service-identity h3').innerText(), 'qwen-fixture-IQ3_S');
    assert.equal(await page.locator('.running-service-heading .badge').innerText(), '模型未加载');
    assert.equal(await page.getByRole('button', { name: '连接管理后台', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '托管此服务', exact: true }).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__runningFixture.actions), []);
  });
  await run('pending-connect-prevents-repeat-and-cross-action', async page => {
    await page.getByRole('button', { name: '连接管理后台', exact: true }).click();
    const connecting = page.getByRole('button', { name: '正在连接…', exact: true });
    assert.equal(await connecting.isDisabled(), true);
    assert.equal(await connecting.getAttribute('aria-busy'), 'true');
    assert.equal(await page.getByRole('button', { name: '托管此服务', exact: true }).isDisabled(), true);
    await page.locator('.running-service-actions').evaluate(element => { for (const button of element.querySelectorAll('button')) { button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
    assert.deepEqual(await page.evaluate(() => window.__runningFixture.actions.map(item => item.action)), ['connect']);
    await page.evaluate(() => window.__runningFixture.release());
    await page.getByRole('button', { name: '连接管理后台', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '托管此服务', exact: true }).isEnabled(), true);
  });
  await run('failed-connect-is-readable-and-never-auto-takes-over', async page => {
    await page.evaluate(() => { window.__runningFixture.failure = 'HTTP 409: {"code":"EXTERNAL_OWNER","message":"服务已由其他管理器托管","details":{"trace":"private"}}'; });
    await page.getByRole('button', { name: '连接管理后台', exact: true }).click();
    await page.evaluate(() => window.__runningFixture.release());
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.equal(await alert.innerText(), '操作失败: 服务已由其他管理器托管');
    assert.deepEqual(await page.evaluate(() => window.__runningFixture.actions.map(item => item.action)), ['connect']);
    assert.equal(await page.locator('.running-service-card').count(), 1);
    assert.equal(await page.getByRole('button', { name: '托管此服务', exact: true }).isEnabled(), true);
    await page.evaluate(() => { window.__runningFixture.failure = undefined; });
    await page.getByRole('button', { name: '托管此服务', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '正在托管…', exact: true }).isDisabled(), true);
    await page.evaluate(() => window.__runningFixture.release());
    await page.getByRole('button', { name: '托管此服务', exact: true }).waitFor();
    assert.equal(await alert.count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__runningFixture.actions.map(item => item.action)), ['connect', 'manage']);
  });
  await run('narrow-english-controls', async page => {
    assert.equal(await page.getByRole('button', { name: 'Connect to manager', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Manage this service', exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }, { viewport: { width: 480, height: 800 }, language: 'en' });
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ scope: 'Real React component with isolated synthetic native IO. No real services or GPU.', results }, null, 2));
  await browser.close(); await server.close();
}
if (results.some(result => !result.passed)) process.exitCode = 1;
