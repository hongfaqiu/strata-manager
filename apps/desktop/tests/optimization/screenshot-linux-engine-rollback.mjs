// Light-theme screenshots of Linux package selection and the trial-start rollback notice (isolated fixture).
// STRATA_SCREENSHOT_DIR picks the output folder (default output/playwright/linux-engine-rollback).
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
const port = 18761;
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false, logLevel: 'warn' });
const output = process.env.STRATA_SCREENSHOT_DIR || resolve(root, 'output/playwright/linux-engine-rollback');
await mkdir(output, { recursive: true }); await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  for (const language of ['zh-CN', 'en']) {
    const zh = language === 'zh-CN', lang = zh ? 'zh' : 'en';
    const open = async query => {
      await page.goto(`http://127.0.0.1:${port}/linux-engine-rollback.html?${[zh ? '' : 'en', query].filter(Boolean).join('&')}`);
      await page.getByRole('button', { name: zh ? '更新至 0.2.0-beta' : 'Update to 0.2.0-beta' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByTestId('runtime-auto-match').waitFor();
      return dialog;
    };
    let dialog = await open('');
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-auto-match"]')?.textContent?.includes('CUDA 13'));
    assert.match(await dialog.getByTestId('runtime-auto-match').innerText(), zh ? /检测到 NVIDIA 驱动 580\.95\.05/ : /Detected NVIDIA driver 580\.95\.05/);
    await dialog.screenshot({ path: resolve(output, `${lang}-linux-auto-match.png`) });
    await dialog.getByRole('combobox', { name: zh ? '官方更新包' : 'Official update package', exact: true }).click();
    for (const label of ['CUDA 12', 'CUDA 13', 'AMD HIP · Strix Halo', 'AMD HIP · RX 7000', 'AMD HIP · RX 9000 / R9700']) await page.getByRole('option', { name: label, exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, `${lang}-linux-package-list.png`) });
    await page.keyboard.press('Escape');

    dialog = await open('gpu=none');
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-auto-match"]')?.getAttribute('role') === 'alert');
    assert.match(await dialog.getByTestId('runtime-auto-match').innerText(), zh ? /手动选择/ : /choose the engine package/);
    await dialog.screenshot({ path: resolve(output, `${lang}-linux-manual-choice.png`) });

    dialog = await open('fail');
    await page.waitForFunction(() => !document.querySelector('.runtime-update-dialog-actions .primary')?.disabled);
    await dialog.getByRole('button', { name: zh ? '确认更新' : 'Confirm update', exact: true }).click();
    const notice = page.getByTestId('runtime-trial-rollback');
    await notice.waitFor({ timeout: 10000 });
    assert.match(await notice.innerText(), zh ? /已恢复原版本 0\.1\.44/ : /Version 0\.1\.44 was restored/);
    await page.locator('.panel').first().screenshot({ path: resolve(output, `${lang}-trial-rollback.png`) });
  }
  assert.deepEqual(failures, []);
  console.log(`screenshots saved to ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
