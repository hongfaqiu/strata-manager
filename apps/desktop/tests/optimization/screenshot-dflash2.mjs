// Light-theme screenshots of 「下载 DFlash2」 (confirm, progress, done, failure) and the drafter in use on the model list (isolated fixture).
// STRATA_SCREENSHOT_DIR picks the output folder (default output/playwright/dflash2).
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
const port = 18763;
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false, logLevel: 'warn' });
const output = process.env.STRATA_SCREENSHOT_DIR || resolve(root, 'output/playwright/dflash2');
await mkdir(output, { recursive: true }); await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  for (const language of ['zh-CN', 'en']) {
    const zh = language === 'zh-CN', lang = zh ? 'zh' : 'en';
    const open = async query => { await page.goto(`http://127.0.0.1:${port}/dflash2.html?${[zh ? '' : 'en', query].filter(Boolean).join('&')}`); };
    await open('hold');
    const control = page.getByTestId('startup-drafting');
    await page.getByTestId('dflash2-download-button').waitFor();
    assert.match(await control.innerText(), zh ? /需先点「下载 DFlash2」，约 1\.2 GB/ : /click “Download DFlash2” first, about 1\.2 GB/);
    await control.screenshot({ path: resolve(output, `s1b-dflash2-offer.${lang}.png`) });
    await page.getByTestId('dflash2-download-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('dflash2-confirm').waitFor();
    assert.match(await dialog.innerText(), /incoai\/Qwen3\.8-Flash-Next-DFlash2/);
    assert.match(await dialog.innerText(), zh ? /约 1\.2 GB，打包后在磁盘上约占 0\.52 GB/ : /about 1\.2 GB/);
    await dialog.screenshot({ path: resolve(output, `s1b-dflash2-confirm.${lang}.png`) });
    await dialog.getByTestId('dflash2-confirm-download').click();
    await page.waitForFunction(() => /45%|\(45%\)/.test(document.querySelector('[data-testid="dflash2-download-progress"]')?.textContent ?? ''), null, { timeout: 15000 });
    await control.screenshot({ path: resolve(output, `s1b-dflash2-progress.${lang}.png`) });
    await open('');
    await page.getByTestId('dflash2-download-button').click();
    await page.getByTestId('dflash2-confirm-download').click();
    await page.getByTestId('dflash2-ready').waitFor({ timeout: 20000 });
    await control.screenshot({ path: resolve(output, `s1b-dflash2-done.${lang}.png`) });
    await open('fail');
    await page.getByTestId('dflash2-download-button').click();
    await page.getByTestId('dflash2-confirm-download').click();
    await page.getByTestId('dflash2-download-error').waitFor({ timeout: 20000 });
    await control.screenshot({ path: resolve(output, `s1b-dflash2-failed.${lang}.png`) });
    await open('view=run&run=mtp');
    await page.getByRole('button', { name: zh ? '详情' : 'Details', exact: true }).click();
    const drafter = page.getByTestId('service-manager-drafter');
    await drafter.waitFor();
    assert.match(await drafter.innerText(), zh ? /实际预测\s*MTP（配置为自动）/ : /Drafter in use\s*MTP \(configured as Auto\)/);
    await page.locator('.service-manager-statuses').first().screenshot({ path: resolve(output, `s1b-run-drafter.${lang}.png`) });
  }
} finally {
  await browser?.close(); await server.close();
}
assert.deepEqual(failures, []);
console.log(`DFlash2 screenshots: ${output}`);
