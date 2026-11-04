// Light-theme screenshots of 「发现 N 个已下载模型 · 一键加入」, 在线下载 | 使用已有模型 and 本机已有 · 直接使用 (isolated fixture),
// with downloaded models and without. STRATA_SCREENSHOT_DIR picks the output folder (default output/playwright/local-model-ui).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const port = 18764;
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false, logLevel: 'warn' });
const output = process.env.STRATA_SCREENSHOT_DIR || resolve(root, 'output/playwright/local-model-ui');
const languages = (process.env.STRATA_SCREENSHOT_LANGUAGES || 'zh-CN,en').split(',');
await mkdir(output, { recursive: true }); await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  for (const language of languages) {
    const zh = language === 'zh-CN', lang = zh ? 'zh' : 'en';
    const open = async query => { await page.goto(`http://127.0.0.1:${port}/local-model-onboard.html?${[zh ? '' : 'en', query].filter(Boolean).join('&')}`); };
    const shot = async name => { await page.mouse.move(0, 0); await page.waitForTimeout(400); return page.screenshot({ path: resolve(output, `${name}.${lang}.png`), fullPage: true }); };
    // With downloaded models: the card, the two sources and 本机已有 on the catalog.
    await open('');
    const card = page.getByTestId('downloaded-models-card');
    await card.waitFor();
    assert.match(await card.innerText(), zh ? /发现 2 个已下载模型 · 一键加入/ : /Found 2 downloaded models · Add in one click/);
    await page.getByTestId('catalog-on-disk').first().waitFor();
    await shot('1-download-with-models');
    await page.locator('.model-download-models button', { hasText: 'Qwen3.8-Flash-Next' }).first().click();
    await page.locator('.model-download-variant', { hasText: 'IQ3_S' }).first().click();
    const direct = page.getByTestId('use-downloaded-model');
    await direct.waitFor();
    assert.match(await direct.innerText(), zh ? /直接使用/ : /Use directly/);
    await shot('2-catalog-on-disk-direct-use');
    await page.getByTestId('downloaded-models-add').click();
    await page.getByTestId('existing-model-section').waitFor();
    await page.waitForFunction(() => /iq3_s/.test(document.querySelector('[data-testid="existing-model-section"]')?.textContent ?? ''), null, { timeout: 15000 });
    await shot('3-existing-prefilled');
    await open('view=models');
    await page.getByTestId('downloaded-models-card').waitFor();
    await shot('4-my-models-empty-with-models');
    await page.getByTestId('downloaded-models-add').click();
    await page.getByTestId('existing-model-section').waitFor();
    // Without downloaded models: no card; 使用已有模型 is still beside 在线下载.
    await open('none');
    await page.getByTestId('model-source-choice').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('downloaded-models-card').count(), 0);
    await shot('5-download-no-models');
    await page.getByTestId('model-source-existing').click();
    await page.getByTestId('existing-model-section').waitFor();
    await shot('6-existing-no-models');
    await open('none&view=models');
    await page.locator('.service-manager-empty').waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('downloaded-models-card').count(), 0);
    await shot('7-my-models-empty-no-models');
  }
} finally {
  await browser?.close(); await server.close();
}
assert.deepEqual(failures, []);
console.log(`Local model onboarding screenshots: ${output}`);
