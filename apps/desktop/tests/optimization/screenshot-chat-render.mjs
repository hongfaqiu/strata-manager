// Screenshots of chat math, the sandboxed HTML preview and the thinking budget field (isolated fixture, no service).
// STRATA_SCREENSHOT_DIR picks the output folder (default output/playwright/chat-render).
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
const port = 18762;
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false, logLevel: 'warn' });
const output = process.env.STRATA_SCREENSHOT_DIR || resolve(root, 'output/playwright/chat-render');
await mkdir(output, { recursive: true }); await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', error => failures.push(error.message));
  for (const lang of ['zh', 'en']) {
    const q = lang === 'en' ? '&en' : '';
    await page.goto(`http://127.0.0.1:${port}/chat-render.html?view=math${q}`);
    await page.waitForFunction(() => document.querySelectorAll('.katex').length >= 4 && !document.querySelector('.st-math--source'));
    assert.equal(await page.locator('.katex-error').count(), 0);
    assert.ok((await page.locator('.st-msg--assistant').innerText()).includes('$5'));
    await page.waitForTimeout(300);
    await page.locator('.chat').screenshot({ path: resolve(output, `${lang}-math.png`) });

    await page.goto(`http://127.0.0.1:${port}/chat-render.html?view=html${q}`);
    await page.locator('.st-code--html').waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'nothing runs before Preview is chosen');
    await page.locator('.st-code--html').screenshot({ path: resolve(output, `${lang}-html-code.png`) });
    await page.getByRole('radio', { name: lang === 'en' ? 'Preview' : '预览' }).click();
    const frame = page.locator('iframe.st-html-preview__frame');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    const note = page.frameLocator('iframe.st-html-preview__frame').locator('#n');
    await note.filter({ hasText: 'network' }).waitFor();
    assert.match(await note.innerText(), /network: blocked · parent access: blocked/);
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    await page.locator('.chat').screenshot({ path: resolve(output, `${lang}-html-preview.png`) });

    await page.goto(`http://127.0.0.1:${port}/chat-render.html?view=settings${q}`);
    await page.locator('#s-thinking-budget').waitFor();
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('#s-thinking-budget').focus(); await page.locator('#s-thinking-budget').blur();
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    assert.equal(await page.locator('[role="listbox"]').count(), 0, 'model list closed');
    await page.locator('.st-drawer').screenshot({ path: resolve(output, `${lang}-thinking-budget.png`) });
  }
  assert.deepEqual(failures, []);
  console.log(`saved to ${output}`);
} finally { await browser?.close(); await server.close(); }
