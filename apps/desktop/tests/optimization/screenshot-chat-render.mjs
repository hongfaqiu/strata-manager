// Screenshots (and checks) of chat math, the sandboxed HTML preview panel and the thinking budget field (isolated fixture, no service).
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

    // The real chat page, re-rendered every 300 ms with new callbacks (as the app does on metric polls).
    const previewLabel = lang === 'en' ? 'Preview' : '预览';
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/chat-render.html?view=chat&tick${q}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const block = page.locator('.st-code--html').first();
    await block.waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'nothing runs before Preview is chosen');
    assert.equal(await block.getAttribute('data-expanded'), 'false', 'html blocks start collapsed');
    assert.ok(await block.locator('pre').isHidden());
    assert.match(await block.locator('.st-code__head').innerText(), /Bouncing balls/);
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    await block.screenshot({ path: resolve(output, `${lang}-html-collapsed.png`) });
    await block.locator('.st-code__toggle').click();
    await page.waitForTimeout(900);
    assert.equal(await block.getAttribute('data-expanded'), 'true', 'expanded state survives re-renders');
    await block.locator('.st-code__toggle').click();
    await block.getByRole('button', { name: previewLabel }).click();
    const frame = page.locator('.chat-preview iframe.st-html-preview__frame');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    const note = page.frameLocator('.chat-preview iframe').locator('#n');
    await note.filter({ hasText: 'network' }).waitFor();
    assert.match(await note.innerText(), /network: allowed · ipc: blocked · parent access: blocked/);
    await page.waitForTimeout(1200); // four re-renders later the panel and its page are still there (regression: #114 Preview snapped back to Code)
    assert.equal(await page.locator('.chat-preview').count(), 1);
    assert.equal(await block.getByRole('button', { name: previewLabel }).getAttribute('aria-pressed'), 'true');
    assert.match(await note.innerText(), /network: allowed/);
    assert.equal(await page.locator('.chat-preview--overlay').count(), 0, 'side by side on a wide window');
    // the chat stays usable next to the panel
    await page.locator('#input').click(); assert.equal(await page.evaluate(() => document.activeElement?.id), 'input');
    // drag the edge: width follows and is remembered
    const handle = page.locator('.chat-preview__resize'), before = (await page.locator('.chat-preview').boundingBox()).width, edge = await handle.boundingBox();
    await page.mouse.move(edge.x + 4, edge.y + 200); await page.mouse.down(); await page.mouse.move(edge.x - 116, edge.y + 200, { steps: 6 }); await page.mouse.up();
    const after = (await page.locator('.chat-preview').boundingBox()).width;
    assert.ok(Math.abs(after - before - 120) <= 2, `dragged ${before} -> ${after}`);
    assert.equal(Number(await page.evaluate(() => localStorage.getItem('strata-manager.chat.htmlPreviewWidth'))), Math.round(after));
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(output, `${lang}-html-panel.png`) });
    // Open in browser (browser mode): a new tab holding the same sandboxed frame
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: lang === 'en' ? 'Open in browser' : '在浏览器中打开' }).click()]);
    await tab.locator('iframe').waitFor();
    assert.equal(await tab.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await tab.title(), 'Bouncing balls');
    await tab.frameLocator('iframe').locator('#n').filter({ hasText: 'network' }).waitFor();
    assert.match(await tab.frameLocator('iframe').locator('#n').innerText(), /network: allowed · ipc: blocked · parent access: blocked/);
    await tab.close();
    // another block replaces the panel's page
    await page.locator('.st-code--html').nth(1).getByRole('button', { name: previewLabel }).click();
    await page.frameLocator('.chat-preview iframe').locator('h1').waitFor();
    assert.equal(await page.locator('.chat-preview').count(), 1);
    assert.equal(await block.getByRole('button', { name: previewLabel }).getAttribute('aria-pressed'), 'false');
    await page.reload(); await page.locator('.st-code--html').first().waitFor();
    await page.locator('.st-code--html').first().getByRole('button', { name: previewLabel }).click();
    await frame.waitFor();
    assert.ok(Math.abs((await page.locator('.chat-preview').boundingBox()).width - after) <= 1, 'width persists');
    await page.getByRole('button', { name: lang === 'en' ? 'Close preview' : '关闭预览' }).last().click();
    assert.equal(await page.locator('.chat-preview').count(), 0);
    // narrow window: a drawer over the chat, Escape closes it
    await page.setViewportSize({ width: 680, height: 820 });
    await page.locator('.st-code--html').first().getByRole('button', { name: previewLabel }).click();
    await page.locator('.chat-preview--overlay iframe').waitFor();
    await page.frameLocator('.chat-preview iframe').locator('#n').filter({ hasText: 'network' }).waitFor();
    await page.mouse.move(5, 5); await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(output, `${lang}-html-narrow.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.chat-preview').count(), 0, 'Escape closes the drawer');
    await page.setViewportSize({ width: 900, height: 900 });

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
