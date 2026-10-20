/**
 * Screenshots for one-click Python (macOS, Python 3.9.6) against isolated fixtures (synthetic native IO, no network).
 *   node scripts/capture-python-oneclick.mjs [outputDir]
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'apps/desktop/tests/optimization');
const output = resolve(process.argv[2] || join(root, 'output/playwright/python-oneclick'));
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const pw = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);

const panel = async page => { const node = page.getByTestId('managed-python'); await node.waitFor(); await node.scrollIntoViewIfNeeded(); await page.waitForTimeout(700); };
const scenes = [
  { id: '01-guide-python-too-old', url: 'python-oneclick-app.html?state=environment&python=idle#guide', action: panel, clip: '.ob-panel' },
  { id: '02-guide-installing', url: 'python-oneclick-app.html?state=environment&python=running#guide', action: panel, clip: '.ob-panel' },
  { id: '03-guide-installed', url: 'python-oneclick-app.html?state=environment&python=idle&step=150#guide', clip: '.ob-panel', action: async page => {
    await page.getByRole('button', { name: '一键安装 Python' }).click();
    await page.getByText('应用内 Python，Strata 会自动使用').waitFor({ timeout: 15000 });
    await page.getByText('Python 3.12.15').first().waitFor();
    if (await page.getByTestId('managed-python').count()) throw new Error('panel should disappear once the check passes');
    if (await page.getByRole('button', { name: '继续 · 安装 Strata' }).isDisabled()) throw new Error('continue stays disabled');
    await page.waitForTimeout(500);
  } },
  { id: '04-guide-runtime-failed', url: 'python-oneclick-app.html?page=runtime-failed&python=idle#guide', action: panel, clip: '.ob-panel' },
  { id: '05-strata-page-failed', url: 'python-oneclick-app.html?page=strata-failed&python=idle#environment', action: panel },
  { id: '06-download-failed-retry', url: 'python-oneclick-app.html?state=environment&python=failed#guide', action: panel, clip: '.ob-panel' },
  { id: '07-strata-page-installed', url: 'python-oneclick-app.html?page=strata-failed&python=done#environment', action: panel },
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, locale: 'zh-CN', colorScheme: 'light', timezoneId: 'America/Los_Angeles' });
    await context.addInitScript(() => { let value; Object.defineProperty(window, '__fixture', { configurable: true, get: () => value, set: next => { const settings = next?.store?.settings ?? next?.state?.store?.settings; if (settings) { settings.language = 'zh-CN'; settings.theme = 'light'; if ('languagePreference' in settings) settings.languagePreference = 'zh-CN'; } value = next; } }); });
    await context.route('**/*', route => { const url = new URL(route.request().url()); return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort(); });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/${scene.url}`);
      await scene.action(page);
      const file = join(output, `${scene.id}.png`);
      if (scene.clip) await page.locator(scene.clip).first().screenshot({ path: file }); else await page.screenshot({ path: file });
      console.log('captured', file, errors.length ? errors : '');
    } catch (error) { failures.push(`${scene.id}: ${error.message}`); await page.screenshot({ path: join(output, `${scene.id}.failed.png`) }); }
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
