import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer as createPortProbe } from 'node:net';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
// Vite treats port:0 as its default port. Obtain an OS-assigned ephemeral port
// first, then bind that specific port with strictPort to avoid other fixtures.
const probe = createPortProbe();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const isolatedPort = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: isolatedPort, strictPort: true, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address === 'object' && address.port === isolatedPort && address.port !== 18081);
const origin = `http://127.0.0.1:${address.port}`, output = resolve(root, 'output/playwright/tuning-compact');
await mkdir(output, { recursive: true });
const results = [], selectedCase = process.env.STRATA_TUNING_CASE;
let browser;
const area = page => page.locator('.tuning-page');
const labels = language => language === 'en' ? {
  title: 'Measure tuning on this computer', purpose: 'How do you mainly use the model?', mode: 'Test mode', full: 'Full scenarios', diagnostic: 'Short diagnostics',
  rounds: 'Repeated rounds', context: 'Context limit for this test', tokens: 'Output limit per request', start: 'Start measurement', cancel: 'Cancel test',
  running: 'Measuring', canceled: 'Canceled', progress: 'Measurement progress', recovery: 'Configuration and service recovery',
  pending: 'Recovery record saved', failure: 'Recovery failed; repair required', apply: 'Apply and verify', restore: 'Restore original parameters',
  short: 'Short chat', chinese: 'Long Chinese response', worker: 'Compare CPU worker count', agent: 'Coding and Agent', noVision: 'Not tested',
} : {
  title: '为这台电脑实测调优', purpose: '你主要怎样使用模型？', mode: '测试模式', full: '完整场景', diagnostic: '短请求诊断',
  rounds: '重复轮数', context: '本次上下文上限', tokens: '每次输出上限', start: '开始实测', cancel: '取消测试',
  running: '测量中', canceled: '已取消', progress: '测量进度', recovery: '配置与服务恢复',
  pending: '已保存恢复记录', failure: '恢复失败，需要修复', apply: '应用并验证', restore: '恢复原参数',
  short: '短对话', chinese: '中文长回答', worker: '比较 CPU 工作线程', agent: '编程与 Agent', noVision: '未测试',
};
async function insideFirstScreen(locator, page, name) {
  assert.equal(await locator.isVisible(), true, `${name} is visible`);
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert.ok(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width, `${name} fits first screen: ${JSON.stringify({ box, viewport })}`);
}
async function firstScreen(page, language) {
  const text = labels(language);
  for (const name of [text.purpose, text.rounds, text.context]) await insideFirstScreen(area(page).getByRole('combobox', { name, exact: true }), page, name);
  await insideFirstScreen(area(page).getByRole('radiogroup', { name: text.mode }), page, text.mode);
  await insideFirstScreen(area(page).getByRole('button', { name: text.start, exact: true }), page, text.start);
  assert.equal(await area(page).locator('.tuning-advanced').evaluate(element => element.open), false);
  assert.equal(await area(page).locator('.tuning-report-details').evaluateAll(elements => elements.every(element => !element.open)), true);
}
async function choose(page, name, value) {
  await area(page).getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
async function advanced(page) {
  const details = area(page).locator('.tuning-advanced');
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
  return details;
}
async function expand(page, name) {
  const summary = area(page).locator('summary').filter({ hasText: name });
  assert.equal(await summary.count(), 1);
  const details = summary.locator('..');
  if (!await details.evaluate(element => element.open)) await summary.click();
  return details;
}
async function noOverflow(page) {
  const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, tuning: document.querySelector('.tuning-page').getBoundingClientRect().width }));
  assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1 && widths.tuning <= widths.viewport + 1, JSON.stringify(widths));
}
async function run(name, language, action, { job = '', viewport = { width: 1366, height: 768 } } = {}) {
  if (selectedCase && selectedCase !== name) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true }), blocked = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/tuning-compact-app.html?language=${language}${job ? `&job=${job}` : ''}#tuning`);
    await area(page).getByRole('heading', { name: labels(language).title, exact: true }).waitFor();
    if (!job) await page.waitForFunction(() => !document.querySelector('[data-testid="tuning-start"]')?.disabled);
    else await area(page).locator('.tuning-progress').waitFor();
    await action(page, labels(language));
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, [], 'No requests attempted outside the isolated fixture origin');
    const forbidden = await page.evaluate(() => window.__fixture.calls.filter(call => /^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|update_runtime_zip|prepare_local_runtime|strata_stream|write_config)$/.test(call.command)));
    assert.deepEqual(forbidden, [], 'No model lifecycle, GPU generation, installation or configuration writes');
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), pageErrors: errors, blocked }); console.log(`FAIL ${name}: ${error}`);
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    await writeFile(resolve(output, `${name}-failure.txt`), await page.locator('body').innerText());
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  for (const language of ['zh-CN', 'en']) {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1800, height: 1200 }]) {
      await run(`first-screen-${language}-${viewport.width}`, language, async (page, text) => {
        await firstScreen(page, language);
        const details = await advanced(page);
        await area(page).getByRole('switch', { name: text.worker, exact: true }).waitFor();
        await details.locator('summary').click();
        await insideFirstScreen(area(page).getByRole('button', { name: text.start, exact: true }), page, text.start);
        await page.screenshot({ path: resolve(output, `first-screen-${language}-${viewport.width}-plan.png`), fullPage: false });
      }, { viewport });
    }
    await run(`full-start-parameters-${language}`, language, async (page, text) => {
      await firstScreen(page, language);
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await area(page).getByRole('button', { name: text.cancel, exact: true }).waitFor();
      const starts = await page.evaluate(() => window.__fixture.tuning.starts);
      assert.deepEqual(starts, [{ profileId: 'a', request: { useCase: 'chat', contextLimit: 8192, includeVision: false, rounds: 2, maxTokens: 1024 } }]);
      assert.match(await area(page).locator('.tuning-progress').innerText(), /7 \/ 24/);
      await insideFirstScreen(area(page).getByRole('button', { name: text.cancel, exact: true }), page, text.cancel);
    });
    await run(`diagnostic-parameters-${language}`, language, async (page, text) => {
      await area(page).getByRole('radio', { name: text.diagnostic, exact: true }).click();
      assert.equal(await area(page).getByRole('combobox', { name: text.purpose, exact: true }).isDisabled(), true);
      await choose(page, text.rounds, '3'); await choose(page, text.tokens, '256');
      const details = await advanced(page);
      await area(page).getByRole('switch', { name: text.chinese, exact: true }).click();
      await details.locator('summary').click();
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await page.waitForFunction(() => window.__fixture.tuning.starts.length === 1);
      const [start] = await page.evaluate(() => window.__fixture.tuning.starts);
      assert.deepEqual(start, { profileId: 'a', request: { scenes: ['chat', 'code'], rounds: 3, maxTokens: 256 } });
    });
    await run(`running-cancel-recovery-${language}`, language, async (page, text) => {
      assert.match(await area(page).locator('.tuning-setup-disclosure>summary').innerText(), new RegExp(text.agent));
      assert.match(await area(page).locator('.tuning-progress').innerText(), new RegExp(text.running));
      assert.equal(await area(page).getByRole('progressbar', { name: text.progress }).getAttribute('aria-valuenow'), '7');
      assert.match(await area(page).locator('.tuning-recovery').innerText(), new RegExp(text.pending));
      assert.equal(await area(page).locator('.tuning-recovery').locator('xpath=ancestor::details').count(), 0);
      await insideFirstScreen(area(page).locator('.tuning-recovery'), page, text.recovery);
      await insideFirstScreen(area(page).getByRole('button', { name: text.cancel, exact: true }), page, text.cancel);
      await page.screenshot({ path: resolve(output, `running-cancel-recovery-${language}-running.png`), fullPage: false });
      await area(page).getByRole('button', { name: text.cancel, exact: true }).click();
      await area(page).locator('.tuning-progress').getByText(text.canceled, { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.cancels), [{ jobId: 'isolated-tuning-job' }]);
      assert.equal(await area(page).locator('.tuning-recovery').isVisible(), true);
    }, { job: 'running' });
    await run(`failed-quality-and-recovery-${language}`, language, async (page, text) => {
      const detail = await page.evaluate(() => window.__fixture.tuning.detail), recoveryError = await page.evaluate(() => window.__fixture.tuning.recoveryError);
      assert.match(await area(page).locator('.tuning-errors').innerText(), new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await area(page).locator('.tuning-errors').locator('xpath=ancestor::details').count(), 0);
      assert.match(await area(page).locator('.tuning-recovery').innerText(), new RegExp(text.failure));
      assert.equal(await area(page).locator('.tuning-recovery').getByText(recoveryError, { exact: true }).isVisible(), true);
      assert.equal(await area(page).locator('.tuning-recovery').locator('xpath=ancestor::details').count(), 0);
      assert.equal(await area(page).getByRole('button', { name: text.start, exact: true }).isDisabled(), true);
      await page.screenshot({ path: resolve(output, `failed-quality-and-recovery-${language}-visible-errors.png`), fullPage: false });
      const details = await expand(page, /^(完整任务明细|Complete workload details)/);
      assert.equal(await details.getByText(detail, { exact: true }).isVisible(), true);
      await details.locator('summary').click();
      assert.equal(await area(page).locator('.tuning-errors').isVisible(), true);
      assert.equal(await area(page).locator('.tuning-recovery').isVisible(), true);
    }, { job: 'failed' });
    await run(`recommendation-apply-restore-${language}`, language, async (page, text) => {
      assert.equal(await area(page).locator('.tuning-report-details').evaluateAll(elements => elements.every(element => !element.open)), true);
      const apply = area(page).getByRole('button', { name: text.apply, exact: true });
      assert.equal(await apply.isEnabled(), true);
      assert.equal(await apply.locator('xpath=ancestor::details').count(), 0);
      await apply.click();
      const restore = area(page).getByRole('button', { name: text.restore, exact: true }); await restore.waitFor();
      assert.equal(await restore.isEnabled(), true); assert.equal(await restore.locator('xpath=ancestor::details').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.applies), [{ jobId: 'isolated-tuning-job', candidateId: 'candidate-1' }]);
      await restore.click();
      await page.waitForFunction(() => window.__fixture.tuning.restores.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.restores), [{ jobId: 'isolated-tuning-job' }]);
      const sceneResults = await expand(page, /^(场景结果|Scenario results)/);
      assert.equal(await sceneResults.locator('[data-testid="tuning-fullAgent"]').isVisible(), true);
      assert.match(await sceneResults.locator('[data-testid="tuning-vision"]').innerText(), new RegExp(text.noVision));
      const candidates = await expand(page, /^(候选比较|Candidate comparison)/);
      assert.equal(await candidates.locator('tbody tr').count(), 1);
      await expand(page, /^(完整任务明细|Complete workload details)/);
      await expand(page, /^(短请求测量明细|Short request measurement details)/);
    }, { job: 'recommended' });
    await run(`narrow-layout-${language}`, language, async (page, text) => {
      await noOverflow(page);
      await insideFirstScreen(area(page).getByRole('button', { name: text.start, exact: true }), page, text.start);
      await page.screenshot({ path: resolve(output, `narrow-layout-${language}-collapsed.png`), fullPage: false });
      await advanced(page); await noOverflow(page);
      for (const name of [/^(场景结果|Scenario results)/, /^(候选比较|Candidate comparison)/, /^(完整任务明细|Complete workload details)/, /^(短请求测量明细|Short request measurement details)/]) await expand(page, name);
      await noOverflow(page);
      const wraps = await area(page).locator('.table-wrap').evaluateAll(elements => elements.map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })));
      assert.ok(wraps.some(wrap => wrap.scroll > wrap.width), 'Wide tables scroll inside their containers');
    }, { job: 'recommended', viewport: { width: 480, height: 1000 } });
  }
  await run('advanced-candidates-and-bounds', 'zh-CN', async (page, text) => {
    await choose(page, text.purpose, text.agent); await choose(page, text.rounds, '4'); await choose(page, text.context, '32,768');
    const details = await advanced(page);
    await area(page).getByRole('switch', { name: text.worker, exact: true }).click();
    await details.locator('summary').click(); await area(page).getByRole('button', { name: text.start, exact: true }).click();
    await page.waitForFunction(() => window.__fixture.tuning.starts.length === 1);
    assert.deepEqual((await page.evaluate(() => window.__fixture.tuning.starts))[0].request, { useCase: 'agent', contextLimit: 32768, includeVision: false, rounds: 4, maxTokens: 1024, restartCandidates: [{ poolWorkers: 8 }] });
    await area(page).getByRole('button', { name: text.cancel, exact: true }).click();
    await area(page).locator('.tuning-progress').getByText(text.canceled, { exact: true }).waitFor();
    await advanced(page);
    for (const name of ['比较异步换入', '比较预填充分块', '比较显存预留', '重排间隔']) await area(page).getByRole('switch', { name, exact: true }).click();
    await details.locator('summary').click();
    assert.equal(await area(page).getByRole('alert').filter({ hasText: '最多选择四个重启候选' }).isVisible(), true);
    assert.equal(await area(page).getByRole('button', { name: text.start, exact: true }).isDisabled(), true);
  });
  await run('legacy-report-cannot-apply', 'zh-CN', async (page, text) => {
    assert.equal(await area(page).getByText('历史短请求报告', { exact: true }).isVisible(), true);
    assert.equal(await area(page).getByRole('button', { name: text.apply, exact: true }).count(), 0);
    await expand(page, /^(候选比较|Candidate comparison)/);
    await expand(page, /^(短请求测量明细|Short request measurement details)/);
  }, { job: 'legacy' });
} finally { await browser?.close(); await server.close(); }
await writeFile(resolve(output, selectedCase ? `browser-results-${selectedCase.replace(/[^a-z0-9-]/gi, '')}.json` : 'browser-results.json'), JSON.stringify({ scope: 'Real React App with in-memory tuning jobs, random fixture port and blocked external HTTP. No native supervisor, GPU, model or installed application acceptance.', fixturePort: address.port, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
