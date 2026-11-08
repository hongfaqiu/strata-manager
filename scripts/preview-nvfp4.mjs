// One-shot NVFP4 catalog preview (#214): the family on an NVIDIA PC, NVFP4-QAD's conversion note (zh / en), the greyed-out
// row on an AMD PC, and a converted QAD checkpoint used in place. Output: STRATA_SCREENSHOT_DIR.
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
const port = 18766;
const server = await createServer({
  configFile: false, root: fixture, plugins: [react()],
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } },
  clearScreen: false, logLevel: 'warn',
});
const output = process.env.STRATA_SCREENSHOT_DIR || resolve('/workspace/sm-nvfp4-preview');
await mkdir(output, { recursive: true });
await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });
  const shot = async name => { await page.mouse.move(0, 0); await page.waitForTimeout(400); await page.screenshot({ path: resolve(output, name), fullPage: true }); };
  const openNvfp4 = async () => {
    const row = page.locator('.model-download-models button', { hasText: 'NVFP4' }).first();
    await row.waitFor();
    await row.click();
    await page.locator('.model-download-variant', { hasText: 'NVFP4-QAD' }).first().waitFor();
  };

  for (const [lang, query] of [['zh', ''], ['en', '&en']]) {
    await page.goto(`http://127.0.0.1:${port}/nvfp4-preview.html?nvidia${query}`);
    await openNvfp4();
    if (lang === 'zh') await shot('1-nvfp4-family-three-packs.zh.png');
    await page.locator('.model-download-variant', { hasText: 'NVFP4-QAD' }).first().click();
    const note = page.getByTestId('nvfp4-prepare');
    await note.waitFor();
    assert.match(await note.innerText(), lang === 'zh' ? /20–40 分钟/ : /20–40 minutes/);
    assert.match(await page.getByTestId('nvfp4-disk').innerText(), /218/);
    await shot(`2-nvfp4-qad-local-conversion.${lang}.png`);
  }

  await page.goto(`http://127.0.0.1:${port}/nvfp4-preview.html?amd`);
  const blocked = page.getByTestId('catalog-mac-unavailable');
  await blocked.waitFor();
  assert.match(await blocked.innerText(), /NVFP4/);
  await page.getByTestId('nvfp4-nvidia-only').waitFor();
  assert.equal(await page.locator('.model-download-models button', { hasText: 'NVFP4' }).count(), 0);
  await blocked.scrollIntoViewIfNeeded();
  await shot('3-amd-nvfp4-unavailable.zh.png');

  await page.goto(`http://127.0.0.1:${port}/nvfp4-preview.html?found`);
  await page.getByTestId('existing-model-section').waitFor();
  const command = page.getByTestId('existing-model-command');
  await command.waitFor({ state: 'attached' });
  await page.waitForFunction(() => /--data-dir/.test(document.querySelector('[data-testid="existing-model-command"]')?.textContent ?? ''));
  const text = await command.textContent();
  assert.match(text, /--family nvfp4 --model NVFP4-QAD/);
  assert.doesNotMatch(text, /--gguf-dir/);
  await shot('4-existing-qad-pack-in-place.zh.png');
} finally {
  await browser?.close();
  await server.close();
}
assert.deepEqual(failures, []);
console.log(`NVFP4 preview: ${output}`);
