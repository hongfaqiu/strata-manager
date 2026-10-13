import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real React UI and real PNG rendering; all service/file/clipboard IO is isolated.
const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const probe = createPortProbe();
await new Promise((resolvePort, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolvePort); });
const port = probe.address().port;
await new Promise((resolvePort, reject) => probe.close(error => error ? reject(error) : resolvePort()));
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const origin = `http://127.0.0.1:${port}`, output = resolve(root, 'output/playwright/benchmark-image-preview');
await mkdir(output, { recursive: true });
const results = [], selectedCase = process.env.STRATA_BENCHMARK_IMAGE_CASE;
let browser;
const area = page => page.locator('.context-benchmark-page:visible');
const resultHeader = page => area(page).locator('.benchmark-results > .panel-header');
const dialog = page => page.getByRole('dialog', { name: '结果图片预览', exact: true });
const preview = page => dialog(page).getByRole('img', { name: 'Benchmark 结果图片', exact: true });
const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

async function prepare(page) {
  await page.goto(`${origin}/benchmark-app.html#benchmark`);
  await area(page).getByRole('heading', { name: '上下文档位实测', exact: true }).waitFor();
  assert.equal(await area(page).locator('.page-header').getByRole('button').count(), 0, 'The page title has no export or guide actions');
  for (const name of ['导出 PNG', '导出 JSON', '导出 CSV', '测试说明']) assert.equal(await area(page).getByRole('button', { name, exact: true }).count(), 0);
  assert.equal(await resultHeader(page).getByRole('button', { name: '复制图片', exact: true }).count(), 1, 'Copy belongs to the results header before history exists');
  assert.equal(await resultHeader(page).getByRole('button', { name: '复制图片', exact: true }).isDisabled(), true);
  assert.equal(await resultHeader(page).getByRole('combobox', { name: '上下文测试历史', exact: true }).count(), 0);
  await page.waitForFunction(() => [...document.querySelectorAll('.context-benchmark-page input[type="checkbox"]')].filter(input => input.checked).length === 2);
  await area(page).getByRole('button', { name: '开始测试', exact: true }).click();
  await page.waitForFunction(() => window.__fixture.store.contextBenchmarkReportsV1?.[0]?.state === 'completed', undefined, { timeout: 60000 });
  await resultHeader(page).getByRole('combobox', { name: '上下文测试历史', exact: true }).waitFor();
  assert.ok(await resultHeader(page).evaluate(header => {
    const copy = header.querySelector('button'), history = header.querySelector('[role="combobox"]');
    return !!copy && !!history && !!(copy.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), 'Copy precedes the result history dropdown');
  await page.evaluate(() => {
    const previous = window.__TAURI_INTERNALS__.invoke;
    const image = window.__fixture.imagePreview = { choices: [], dialogs: [], writes: [], copies: [], downloads: 0, failWrite: false, failCopy: false, revoked: [] };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'plugin:dialog|save') { image.dialogs.push(structuredClone(args)); return image.choices.shift() ?? null; }
      if (command === 'write_png_export') {
        image.writes.push(structuredClone(args));
        if (image.failWrite) throw Error('Fixture PNG save failed');
        return args.path;
      }
      return previous(command, args);
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => {
      if (image.failCopy) throw Error('Fixture clipboard write failed');
      for (const item of items) {
        const blob = await item.getType('image/png');
        image.copies.push({ type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] });
      }
    } } });
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { image.revoked.push(value); return revoke(value); };
  });
}

async function openPreview(page) {
  await resultHeader(page).getByRole('button', { name: '复制图片', exact: true }).click();
  await preview(page).waitFor();
  await preview(page).evaluate(image => image.decode());
  const image = await preview(page).evaluate(async element => {
    const blob = await (await fetch(element.src)).blob();
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.drawImage(element, 0, 0, 80, 80);
    const pixels = ctx.getImageData(0, 0, 80, 80).data;
    const colors = new Set(); for (let index = 0; index < pixels.length; index += 4) colors.add(pixels.slice(index, index + 4).join(','));
    return { src: element.src, width: element.naturalWidth, height: element.naturalHeight, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())], colors: colors.size };
  });
  assert.equal(image.type, 'image/png'); assert.ok(image.width >= 1600 && image.height > 1000); assert.ok(image.colors > 30, 'Preview has real chart/table pixels');
  assert.deepEqual(image.bytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  const effects = await page.evaluate(() => window.__fixture.imagePreview);
  assert.equal(effects.copies.length, 0, 'Opening preview never copies'); assert.equal(effects.dialogs.length, 0, 'Opening preview never opens Save As'); assert.equal(effects.writes.length, 0, 'Opening preview never writes');
  return image;
}

async function closePreview(page) {
  await dialog(page).getByRole('button', { name: /^(关闭|Close)$/, exact: true }).last().click();
  await dialog(page).waitFor({ state: 'hidden' });
}

async function run(name, action, viewport = { width: 1440, height: 1050 }) {
  if (selectedCase && selectedCase !== name) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], downloads = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(String(error))); page.on('download', download => downloads.push(download));
  try {
    await prepare(page); await action(page, downloads);
    assert.deepEqual(errors, [], 'No uncaught React/browser errors');
    const forbidden = await page.evaluate(() => window.__fixture.calls.filter(call => /^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|tuning_start|update_runtime_zip|prepare_local_runtime)$/.test(call.command)));
    assert.deepEqual(forbidden, [], 'Preview/export never changes model lifecycle');
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), pageErrors: errors }); console.log(`FAIL ${name}: ${error}`);
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    await writeFile(resolve(output, `${name}-failure.txt`), await page.locator('body').innerText());
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  await run('copy-entry-previews-before-confirmation', async (page, downloads) => {
    const image = await openPreview(page);
    assert.equal(downloads.length, 0);
    await page.screenshot({ path: resolve(output, 'copy-entry-preview.png'), fullPage: true });
    await dialog(page).getByRole('button', { name: '复制图片', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.imagePreview.copies.length === 1);
    const copy = await page.evaluate(() => window.__fixture.imagePreview.copies[0]);
    assert.equal(digest(copy.bytes), digest(image.bytes), 'Clipboard receives the exact preview PNG');
    assert.equal(copy.type, 'image/png');
    await closePreview(page);
    assert.ok(await page.evaluate(src => window.__fixture.imagePreview.revoked.includes(src), image.src), 'Preview object URL is released after close');
  });
  await run('copy-entry-close-does-not-write', async (page, downloads) => {
    const image = await openPreview(page);
    await closePreview(page);
    assert.equal(downloads.length, 0);
    const effects = await page.evaluate(() => window.__fixture.imagePreview);
    assert.equal(effects.copies.length, 0); assert.equal(effects.dialogs.length, 0); assert.equal(effects.writes.length, 0);
    assert.ok(effects.revoked.includes(image.src));
  });
  await run('native-save-cancel-failure-retry-directory', async (page, downloads) => {
    const image = await openPreview(page);
    await dialog(page).getByRole('button', { name: '另存为 PNG', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.imagePreview.dialogs.length === 1);
    assert.equal((await page.evaluate(() => window.__fixture.imagePreview.writes)).length, 0, 'Cancelling Save As never writes');
    const choice = 'C:\\fixture exports\\另一个目录\\benchmark.png';
    await page.evaluate(path => { window.__fixture.imagePreview.choices.push(path); window.__fixture.imagePreview.failWrite = true; }, choice);
    await dialog(page).getByRole('button', { name: '另存为 PNG', exact: true }).click();
    await dialog(page).getByRole('alert').waitFor();
    assert.match(await dialog(page).getByRole('alert').innerText(), /Fixture PNG save failed/);
    await page.evaluate(path => { window.__fixture.imagePreview.choices.push(path); window.__fixture.imagePreview.failWrite = false; }, choice);
    await dialog(page).getByRole('button', { name: '另存为 PNG', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.imagePreview.writes.length === 2);
    const effects = await page.evaluate(() => window.__fixture.imagePreview);
    assert.equal(effects.dialogs.length, 3); assert.equal(effects.copies.length, 0); assert.equal(downloads.length, 0);
    const options = effects.dialogs[0].options;
    assert.match(options.defaultPath, /^strata-context-benchmark-.+\.png$/);
    assert.ok(options.filters.some(filter => filter.extensions.includes('png')), 'Native Save As filters PNG');
    for (const write of effects.writes) { assert.equal(write.path, choice); assert.equal(digest(write.bytes), digest(image.bytes), 'Selected destination receives the exact preview PNG'); }
  });
  await run('browser-save-picker-cancel-and-directory', async (page, downloads) => {
    const image = await openPreview(page);
    await page.evaluate(() => {
      window.__fixture.savedTauri = window.__TAURI_INTERNALS__; delete window.__TAURI_INTERNALS__;
      const state = window.__fixture.browserPicker = { calls: [], writes: [], closed: 0, cancel: true };
      window.showSaveFilePicker = async options => {
        state.calls.push(options);
        if (state.cancel) throw new DOMException('User cancelled', 'AbortError');
        return { name: 'benchmark.png', createWritable: async () => ({ write: async blob => state.writes.push([...new Uint8Array(await blob.arrayBuffer())]), close: async () => { state.closed++; }, abort: async () => {} }) };
      };
    });
    await dialog(page).getByRole('button', { name: '另存为 PNG', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.browserPicker.calls.length === 1);
    assert.equal((await page.evaluate(() => window.__fixture.browserPicker.writes)).length, 0);
    await page.evaluate(() => { window.__fixture.browserPicker.cancel = false; });
    await dialog(page).getByRole('button', { name: '另存为 PNG', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.browserPicker.closed === 1);
    const effects = await page.evaluate(() => window.__fixture.browserPicker);
    assert.match(effects.calls[1].suggestedName, /\.png$/); assert.equal(digest(effects.writes[0]), digest(image.bytes));
    assert.equal(downloads.length, 0);
    await page.evaluate(() => { window.__TAURI_INTERNALS__ = window.__fixture.savedTauri; });
  });
  await run('browser-download-fallback-confirms-first', async (page, downloads) => {
    const image = await openPreview(page);
    assert.equal(downloads.length, 0);
    await page.evaluate(() => { window.__fixture.savedTauri = window.__TAURI_INTERNALS__; delete window.__TAURI_INTERNALS__; window.showSaveFilePicker = undefined; });
    const downloaded = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: '另存为 PNG', exact: true }).click();
    const download = await downloaded, bytes = await readFile(await download.path());
    assert.match(download.suggestedFilename(), /^strata-context-benchmark-.+\.png$/); assert.equal(digest(bytes), digest(image.bytes));
    assert.equal(downloads.length, 1);
    await page.evaluate(() => { window.__TAURI_INTERNALS__ = window.__fixture.savedTauri; });
  });
  await run('narrow-preview-keeps-actions-visible', async page => {
    await openPreview(page);
    const bounds = await dialog(page).boundingBox(), viewport = page.viewportSize();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'Dialog fits narrow viewport');
    for (const name of ['复制图片', '另存为 PNG']) {
      const action = await dialog(page).getByRole('button', { name, exact: true }).boundingBox();
      assert.ok(action && action.y >= 0 && action.y + action.height <= viewport.height + 1, `${name} remains visible`);
    }
  }, { width: 480, height: 800 });
} finally { await browser?.close(); await server.close(); }
const resultName = selectedCase ? `browser-results-${selectedCase}.json` : 'browser-results.json';
await writeFile(resolve(output, resultName), JSON.stringify({ scope: 'Real React App, synthetic service and native Save As, mocked clipboard. PNG generated and decoded by real Edge. No supervisor, GPU, OS dialog or native file-write acceptance.', fixtureOrigin: origin, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
