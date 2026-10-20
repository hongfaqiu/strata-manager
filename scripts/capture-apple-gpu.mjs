/**
 * Fixture renders for Apple Silicon GPU detection (M5 Pro, 48 GB) — synthetic native IO, no network, not a real Mac.
 *   node scripts/capture-apple-gpu.mjs [outputDir]
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'apps/desktop/tests/optimization');
const output = resolve(process.argv[2] || join(root, 'output/playwright/apple-gpu'));
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const pw = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);

const settle = page => page.waitForTimeout(700);
const expectText = async (page, text) => { await page.getByText(text).first().waitFor({ timeout: 10000 }); };
const envStep = async page => {
  await page.locator('[data-testid="onboarding"]').waitFor();
  // A passing environment auto-advances; open the finished step to show what was detected.
  if (await page.locator('[data-testid="onboarding"]').getAttribute('data-step') !== 'environment') await page.locator('.ob-step', { hasText: '检查运行环境' }).first().click();
  await page.locator('[data-testid="onboarding"][data-step="environment"]').waitFor();
};
const scenes = [
  { id: '01-before-v0.2.10-env-check', url: 'onboarding-app.html?state=environment&mac=old#guide', clip: '.ob-panel', action: async page => { await envStep(page); await expectText(page, '未检测到显卡，生成会很慢'); await settle(page); } },
  { id: '02-after-env-check', url: 'onboarding-app.html?state=environment&mac=m5pro#guide', clip: '.ob-panel', action: async page => {
    await envStep(page); await expectText(page, 'Apple M5 Pro · Metal 4'); await expectText(page, '20 核 GPU');
    if (await page.getByText('未检测到显卡，生成会很慢').count()) throw new Error('no-GPU warning still shown');
    await settle(page);
  } },
  { id: '03-after-guide-entry', url: 'onboarding-app.html?state=entry&mac=m5pro', clip: '.ob-panel', action: async page => { await page.waitForURL(url => url.hash === '#guide'); await expectText(page, 'Apple M5 Pro · Metal 4'); await settle(page); } },
  { id: '04-after-environment-devices', url: 'onboarding-app.html?state=ready&mac=m5pro#environment', clip: '[data-testid="d2-environment-devices"]', action: async page => { await expectText(page, '统一内存 48 GB'); await settle(page); } },
  { id: '05-after-models-capacity', url: 'onboarding-app.html?state=ready&mac=m5pro#models', clip: '[data-testid="d2-models-lead"]', action: async page => { await page.locator('[data-testid="d2-models-lead"]').waitFor(); await expectText(page, 'GPU 可用'); await settle(page); } },
  { id: '06-after-overview-hardware', url: 'onboarding-app.html?state=ready&mac=m5pro#overview', clip: '.ovw-map', action: async page => { await page.locator('.ovw-map').waitFor(); await expectText(page, '片上 · 统一内存'); await settle(page); } },
];

await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
const failures = [];
try {
  for (const scene of scenes) {
    if (process.env.SCENES && !process.env.SCENES.split(',').includes(scene.id)) continue;
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: 'light', timezoneId: 'Asia/Shanghai' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort(); });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/${scene.url}`);
      await scene.action(page);
      if (errors.length) throw new Error(errors.join('; '));
      const file = join(output, `${scene.id}.png`);
      if (scene.clip) await page.locator(scene.clip).first().screenshot({ path: file }); else await page.screenshot({ path: file });
      await page.screenshot({ path: join(output, `${scene.id}.full.png`) });
      console.log('captured', file);
    } catch (error) { failures.push(`${scene.id}: ${error.message}`); await page.screenshot({ path: join(output, `${scene.id}.failed.png`) }); }
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
