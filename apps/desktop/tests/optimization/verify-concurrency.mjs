import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// Concurrency UI regression on mock data + optional zh/en screenshots (CONCURRENCY_SCREENSHOTS=<dir>).
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const shots = process.env.CONCURRENCY_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
let failed = 0;
async function run(name, scene, lang, check, shot) {
  const context = await browser.newContext({ viewport: { width: 1160, height: 1600 }, deviceScaleFactor: shots ? 2 : 1 });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/concurrency-preview.html?scene=${scene}&lang=${lang}`);
    let taken = false;
    const snap = async () => { if (!shots || !shot || taken) return; taken = true; await page.waitForTimeout(300); await page.locator('main > :not([hidden])').first().screenshot({ path: resolve(shots, `${shot}-${lang === 'en' ? 'en' : 'zh'}.png`) }); };
    await check(page, snap);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('details').count(), 0, 'no folded sections');
    await snap();
    console.log(`PASS ${name} (${lang})`);
  } catch (error) { failed++; console.log(`FAIL ${name} (${lang}): ${error}`); }
  finally { await context.close(); }
}
const zh = lang => lang !== 'en';
try {
  for (const lang of ['zh', 'en']) {
    await run('16 GB card recommends conversation parking for agents', 'card-16gb', lang, async (page, snap) => {
      await page.getByRole('radio', { name: zh(lang) ? 'Agent / 子 Agent' : 'Agents' }).click().catch(async () => page.getByText(zh(lang) ? 'Agent / 子 Agent' : 'Agents', { exact: true }).click());
      const rec = page.getByTestId('concurrency-recommendation');
      await rec.getByText(zh(lang) ? '一次一个' : 'One at a time').waitFor();
      assert.match(await rec.innerText(), zh(lang) ? /会话暂存 8 GiB × 4/ : /parking 8 GiB × 4/);
      await snap();
      await page.getByTestId('concurrency-apply').click();
      const draft = JSON.parse(await page.getByTestId('draft').textContent());
      assert.deepEqual(draft.args.slice(-4), ['--conversation-cache-mib', '8192', '--conversation-cache-slots', '4']);
    }, 'config-card-16gb');
    await run('32 GB card recommends four slots with batch MTP', 'card-32gb', lang, async page => {
      await page.getByText(zh(lang) ? '多人 / 多客户端' : 'Several users', { exact: true }).click();
      await page.getByTestId('concurrency-recommendation').getByText(zh(lang) ? '4 个同时' : '4 at once').waitFor();
      assert.equal(await page.getByTestId('concurrency-experimental').count(), 0);
    }, 'config-card-32gb');
    await run('layer split: trim weights, batch MTP off with pipelined groups, experimental switches', 'card-multi-gpu', lang, async page => {
      await page.getByTestId('concurrency-experimental').waitFor();
      assert.equal(await page.locator('[data-code="batch_mtp_pipeline_off"]').count(), 1);
      assert.match(await page.getByTestId('concurrency-card').innerText(), /--trim-stage-weights/);
      assert.match(await page.getByTestId('concurrency-experimental').innerText(), zh(lang) ? /实验/ : /Experimental/);
    }, 'config-card-multi-gpu');
    await run('ladder running', 'ladder-running', lang, async page => { await page.locator('[data-testid="concurrency-ladder"][data-state="running"]').waitFor(); assert.equal(await page.locator('.concurrency-ladder-steps li[data-state="live"]').count(), 1); }, 'ladder-running');
    await run('ladder result', 'ladder-result', lang, async page => { assert.match(await page.getByTestId('concurrency-ladder-verdict').innerText(), zh(lang) ? /4 个同时时总吞吐最高：105 tok\/s/ : /peaks at 4 at once: 105 tok\/s/); assert.equal(await page.locator('.concurrency-chart-bar').count(), 3); }, 'ladder-result');
    await run('slot monitor', 'slots', lang, async page => {
      await page.getByTestId('slot-monitor').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.slot-spark path').length >= 2);
      assert.equal(await page.getByRole('button', { name: zh(lang) ? '更多指标' : 'More metrics' }).count(), 0);
      assert.equal(await page.locator('.slot-monitor-table th').count(), 9);
    }, 'slot-monitor');
    await run('tuning comparison result', 'comparison', lang, async page => { assert.match(await page.getByTestId('concurrency-comparison-verdict').innerText(), zh(lang) ? /总吞吐最高：125 tok\/s/ : /125 tok\/s/); }, 'tuning-comparison');
    await run('tuning comparison running', 'comparison-running', lang, async page => { await page.getByRole('status').waitFor(); }, 'tuning-comparison-running');
  }
} finally { await browser.close(); await server.close(); }
if (failed) { console.log(`${failed} failed`); process.exit(1); }
