/**
 * Screenshots for the version-switch feature against isolated fixtures (synthetic native IO, no network).
 *   node scripts/capture-version-switch.mjs [outputDir]
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'apps/desktop/tests/optimization');
const output = resolve(process.argv[2] || join(root, 'output/playwright/version-switch'));
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const pw = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);

const open = async page => { const choice = page.getByTestId('runtime-version-choice'); await choice.waitFor(); await choice.scrollIntoViewIfNeeded(); return choice; };
const pick = async (page, version) => { const choice = await open(page); await choice.getByRole('combobox', { name: '选择版本' }).or(choice.getByLabel('选择版本')).first().click(); await page.getByRole('option', { name: new RegExp(`^${version.replace(/\./g, '\\.')}`) }).first().click(); };
const scenes = [
  { id: '01-strata-page-versions', url: 'version-switch-app.html?language=zh-CN&theme=light#environment', action: async page => { await open(page); await page.waitForTimeout(800); } },
  { id: '02-version-list', url: 'version-switch-app.html?language=zh-CN&theme=light#environment', action: async page => { const choice = await open(page); await page.mouse.wheel(0, 400); await choice.getByLabel('选择版本').first().click(); await page.getByRole('option').first().waitFor(); await page.waitForTimeout(500); } },
  { id: '03-downgrade-confirm', url: 'version-switch-app.html?language=zh-CN&theme=light#environment', action: async page => { await pick(page, '0.1.44'); await page.getByRole('button', { name: '降级到此版本' }).click(); await page.getByTestId('runtime-downgrade-warning').waitFor(); await page.waitForTimeout(900); } },
  { id: '04-pinned', url: 'version-switch-app.html?language=zh-CN&theme=light&latest=0.2.2&pin=0.2.1#environment', action: async page => { await open(page); await page.getByText('已固定在 0.2.1').first().waitFor(); await page.waitForTimeout(800); } },
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
