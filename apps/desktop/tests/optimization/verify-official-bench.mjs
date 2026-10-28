import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// 「官方基准」 UI on mock data + optional screenshots (OFFICIAL_BENCH_SCREENSHOTS=<dir>).
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const shots = process.env.OFFICIAL_BENCH_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
let failed = 0;
const scenes = {
  match: async page => {
    const banner = await page.getByTestId('official-match').innerText();
    assert.match(banner, /官方对照.*Qwen3\.8-Flash-Next IQ3_S/);
    assert.match(banner, /STRIX_HALO_WINDOWS\.md/);
    const table = await page.locator('.obench-table').innerText();
    assert.match(table, /对话解码[\s\S]*44\.0/);
    assert.match(table, /对话首字[\s\S]*0\.60/);
    assert.match(table, /32K 预填充[\s\S]*792/);
    assert.equal(await page.locator('.bhc-card').count(), 4);
  },
  range: async page => {
    assert.match(await page.getByTestId('official-match').innerText(), /DeepSeek V4\.1-Flash 2\.00 bpw/);
    assert.match(await page.locator('.obench-table').innerText(), /12\.1–13\.6/);
    assert.match(await page.locator('.obench-note').first().innerText(), /区间中点/);
  },
  nomatch: async page => {
    assert.match(await page.getByTestId('official-match').innerText(), /官方暂无此配置数据/);
    assert.match(await page.locator('.obench-note').first().innerText(), /已跳过 32K/);
    assert.equal(await page.locator('.bhc-card').count(), 0);
    assert.equal(await page.locator('.obench-table th').count(), 2);
  },
  running: async page => {
    assert.equal(await page.locator('.obench-steps li[data-state="done"]').count(), 3);
    assert.equal(await page.locator('.obench-steps li[data-state="now"]').count(), 1);
  },
  idle: async page => { await page.getByRole('button', { name: '一键开始（官方参数）' }).waitFor(); },
};
try {
  for (const [scene, check] of Object.entries(scenes)) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 1300 }, deviceScaleFactor: shots ? 2 : 1 });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/official-bench-preview.html?scene=${scene}`);
      await page.locator('.official-benchmark-page').waitFor();
      await check(page);
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('details').count(), 0, 'no folded sections');
      if (shots) { await page.waitForTimeout(300); await page.locator('.official-benchmark-page').screenshot({ path: resolve(shots, `official-bench-${scene}.png`) }); }
      console.log(`PASS ${scene}`);
    } catch (error) { failed++; console.log(`FAIL ${scene}: ${error}`); }
    finally { await context.close(); }
  }
  // Full app on the native fixture: the tab exists, one click runs the suite through strata_stream and stores a report.
  const context = await browser.newContext({ viewport: { width: 1360, height: 1100 }, deviceScaleFactor: shots ? 2 : 1 });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/benchmark-app.html#benchmark`);
    await page.getByRole('radio', { name: '官方基准', exact: true }).click();
    const area = page.locator('.official-benchmark-page');
    await area.getByRole('button', { name: '一键开始（官方参数）' }).click();
    await page.waitForFunction(() => !!window.__fixture.store.officialBenchmarkReportsV1?.length, undefined, { timeout: 60000 });
    const streams = await page.evaluate(() => window.__fixture.benchmark.streams.map(s => s.body.max_tokens));
    // fixture context 32768: warm-up (24, 1, 1, 8), chat 3x3 (100), 4K and 16K x3 (24), agent 3x6 (64); 32K does not fit.
    assert.deepEqual(streams, [24, 1, 1, 8, ...Array(9).fill(100), ...Array(6).fill(24), ...Array(18).fill(64)]);
    const stored = await page.evaluate(() => window.__fixture.store.officialBenchmarkReportsV1[0]);
    assert.equal(stored.state, 'completed');
    assert.deepEqual(stored.results.skipped, { '32K': 'the context is 32768 tokens' });
    await area.getByTestId('official-match').getByText('官方暂无此配置数据').waitFor();
    assert.deepEqual(errors, []);
    if (shots) { await page.waitForTimeout(300); await page.locator('.management-content--benchmark, main').first().screenshot({ path: resolve(shots, 'official-bench-app.png') }); }
    console.log('PASS app (one-click run on the native fixture)');
  } catch (error) { failed++; console.log(`FAIL app: ${error}`); }
  finally { await context.close(); }
} finally { await browser.close(); await server.close(); }
process.exit(failed ? 1 : 0);
