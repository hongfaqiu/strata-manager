// One-shot Unsloth Dynamic v3.1 catalog preview (zh-CN). Output: STRATA_SCREENSHOT_DIR.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/tests/optimization');
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const port = 18765;
const server = await createServer({
  configFile: false, root: fixture, plugins: [react()],
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } },
  clearScreen: false, logLevel: 'warn',
});
const output = process.env.STRATA_SCREENSHOT_DIR || resolve('/workspace/docs-preview/unsloth-v31');
await mkdir(output, { recursive: true });
await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/local-model-onboard.html?v31`);
  await page.getByTestId('downloaded-models-card').waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(output, '1-download-unsloth-v31-on-disk.zh.png'), fullPage: true });

  // Open Unsloth family → show v3.1 quants with 本机已有 on UD-IQ1_M / UD-IQ4_XS-v31
  const unslothBtn = page.locator('.model-download-models button', { hasText: 'Unsloth' }).first();
  await unslothBtn.waitFor();
  await unslothBtn.click();
  await page.locator('.model-download-variant', { hasText: 'UD-IQ1_M' }).first().waitFor();
  await page.locator('.model-download-variant', { hasText: 'UD-IQ4_XS-v31' }).first().waitFor();
  await page.getByTestId('catalog-on-disk').first().waitFor();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(output, '2-unsloth-v31-quants-on-disk.zh.png'), fullPage: true });

  // Select UD-IQ4_XS-v31 → 直接使用
  await page.locator('.model-download-variant', { hasText: 'UD-IQ4_XS-v31' }).first().click();
  const direct = page.getByTestId('use-downloaded-model');
  await direct.waitFor();
  assert.match(await direct.innerText(), /直接使用/);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(output, '3-ud-iq4-xs-v31-direct-use.zh.png'), fullPage: true });
} finally {
  await browser?.close();
  await server.close();
}
assert.deepEqual(failures, []);
console.log(`Unsloth v3.1 preview: ${output}`);
