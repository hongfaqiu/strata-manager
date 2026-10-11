import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
// Vite treats zero as its default port; obtain an OS-assigned free port first.
const probe = createPortProbe();
await new Promise((resolvePort, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolvePort); });
const fixturePort = probe.address().port;
await new Promise((closePort, reject) => probe.close(error => error ? reject(error) : closePort()));
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: fixturePort, strictPort: true, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const address = server.httpServer.address();
assert.ok(address && typeof address === 'object', 'Isolated fixture has a random listening port');
const origin = `http://127.0.0.1:${address.port}`, output = resolve(root, 'output/playwright/benchmark-compact');
await mkdir(output, { recursive: true });
const results = [];
const selectedCase = process.env.STRATA_BENCHMARK_CASE;
let browser;
const area = page => page.locator('.benchmark-page');
async function navigate(page, hash) {
  const labels = { models: '模型', chat: '聊天', tuning: '参数调优', environment: 'Strata', monitoring: '监控' };
  if (hash === 'benchmark') {
    await page.locator('.manager-nav').getByRole('button', { name: '监控', exact: true }).click();
    await page.locator('.workspace-subnav').getByRole('button', { name: 'Benchmark 测试', exact: true }).click();
  } else if (hash === 'usage') await page.locator('.workspace-subnav').getByRole('button', { name: 'API 使用统计', exact: true }).click();
  else await page.locator('.manager-nav').getByRole('button', { name: labels[hash], exact: true }).click();
  await page.waitForFunction(value => location.hash === `#${value}`, hash);
}
async function streams(page) { return page.evaluate(() => window.__fixture.benchmark.streams); }
async function reports(page) { return page.evaluate(() => window.__fixture.store.benchmarkReportsV1 ?? []); }
async function finish(page) { await page.waitForFunction(() => !!window.__fixture.store.benchmarkReportsV1?.length, undefined, { timeout: 60000 }); await area(page).getByRole('button', { name: /^(开始测试|Start benchmark)$/ }).waitFor(); }
async function chooseScenarios(page, ids) {
  const names = { short: /^(短问答|Short answer)$/, code: /^(代码审查|Code review)$/, long: /^(长输入|Long input)$/, decode: /^(持续生成|Sustained generation)$/, cache: /^(重复输入缓存|Repeated input cache)$/, conversation: /^(多轮对话|Conversation)$/, custom: /^(自定义|Custom)$/ };
  for (const [id, name] of Object.entries(names)) await area(page).getByRole('checkbox', { name, exact: true }).setChecked(ids.includes(id));
}
async function advanced(page) {
  const details = area(page).locator('.benchmark-advanced');
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
}
async function section(page, label) {
  const summary = area(page).locator('summary').filter({ hasText: label });
  await summary.waitFor();
  assert.equal(await summary.count(), 1, `One section matches ${label}`);
  const details = summary.locator('..');
  if (!await details.evaluate(element => element.open)) await summary.click();
  return details;
}
async function assertFirstScreen(page) {
  const button = area(page).getByRole('button', { name: /^(开始测试|Start benchmark)$/ });
  const bounds = await button.boundingBox(), viewport = page.viewportSize();
  assert.ok(bounds && viewport && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `Start action fits first screen: ${JSON.stringify({ bounds, viewport })}`);
  assert.equal(await area(page).getByRole('checkbox').count(), 7);
  assert.equal(await area(page).locator('.benchmark-advanced').evaluate(element => element.open), false);
  assert.equal(await area(page).locator('.benchmark-scenario small').count(), 0, 'Scene explanations are on demand');
}
async function dropdown(page, label, option) {
  await area(page).getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function configure(page, { rounds = 2, timeout = 5, warmup = false, repeat = false, scenarios = ['custom'], stopOnError = false } = {}) {
  await chooseScenarios(page, scenarios);
  await area(page).getByRole('spinbutton', { name: /^(测试轮数|Rounds per scenario)$/ }).fill(String(rounds));
  await advanced(page);
  await area(page).getByRole('spinbutton', { name: /^(每轮超时（秒）|Timeout per request \(seconds\))$/ }).fill(String(timeout));
  if (warmup) await area(page).getByRole('switch', { name: /^(先预热一次|Run one warmup)$/ }).click();
  if (repeat) await dropdown(page, /^(输入模式|Input mode)$/, /^(重复输入 · 测试缓存|Repeated input · cache test)$/);
  if (stopOnError) await area(page).getByRole('switch', { name: /^(发生错误后停止|Stop on error)$/ }).click();
}
async function stress(page, { concurrency = 4, budget = 12, duration = 30, pattern = 'steady', scenarios = ['short'], timeout = 30, stage = 5 } = {}) {
  await area(page).getByRole('radio', { name: /^(压力测试|Stress test)$/, exact: true }).click();
  await chooseScenarios(page, scenarios);
  await area(page).getByRole('spinbutton', { name: /^(最大并发|Maximum concurrency)$/ }).fill(String(concurrency));
  await area(page).getByRole('spinbutton', { name: /^(请求预算|Request budget)$/ }).fill(String(budget));
  await area(page).getByRole('spinbutton', { name: /^(持续时间（秒）|Duration \(seconds\))$/ }).fill(String(duration));
  await dropdown(page, /^(压力模式|Load pattern)$/, pattern === 'steady' ? /^(固定并发|Fixed concurrency)$/ : /^(逐级升压|Gradual ramp)$/);
  await advanced(page);
  await area(page).getByRole('spinbutton', { name: /^(每轮超时（秒）|Timeout per request \(seconds\))$/ }).fill(String(timeout));
  if (pattern === 'ramp') await area(page).getByRole('spinbutton', { name: /^(每级持续时间（秒）|Duration per stage \(seconds\))$/ }).fill(String(stage));
}
async function start(page) { await area(page).getByRole('button', { name: /^(开始测试|Start benchmark)$/ }).click(); }
async function run(name, action, search = '', viewport = { width: 1440, height: 1050 }) {
  if (selectedCase && selectedCase !== name) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  // Blocking everything outside the fixture prevents all accidental model IO.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/benchmark-app.html${search}#benchmark`);
    await area(page).getByRole('heading', { name: /^(Benchmark 性能测试|Benchmark)$/ }).waitFor();
    await action(page);
    assert.deepEqual(errors, []);
    const forbidden = await page.evaluate(() => window.__fixture.calls.filter(call => /^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|tuning_start|update_runtime_zip|prepare_local_runtime)$/.test(call.command)));
    assert.deepEqual(forbidden, [], 'Benchmark never changes service lifecycle, tuning or installation');
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
  await run('serial-sse-metrics-history-export', async page => {
    const checkboxStyle = await area(page).getByRole('checkbox', { name: '短问答', exact: true }).evaluate(element => ({ checked: element.checked, padding: getComputedStyle(element).padding, appearance: getComputedStyle(element).appearance }));
    assert.deepEqual(checkboxStyle, { checked: true, padding: '0px', appearance: 'auto' });
    await configure(page, { warmup: true }); await start(page); await finish(page);
    const [report] = await reports(page), calls = await streams(page);
    assert.equal(report.state, 'completed'); assert.equal(report.samples.length, 3); assert.equal(calls.length, 3);
    assert.deepEqual(report.samples.map(sample => sample.index), [0, 1, 2]);
    assert.equal(report.samples[0].warmup, true);
    for (const sample of report.samples.slice(1)) {
      assert.equal(sample.promptTokens, 100); assert.equal(sample.completionTokens, 10); assert.equal(sample.cachedTokens, 40);
      assert.equal(sample.prefillTokS, 1250); assert.equal(sample.decodeTokS, 80);
      assert.ok(sample.ttftMs >= 0 && sample.ttftMs < sample.wallMs); assert.match(sample.output, /fixture output/);
    }
    assert.equal(new Set(calls.map(call => call.body.messages[0].content)).size, 3);
    for (const call of calls) { assert.equal(call.body.model, 'Fixture A'); assert.equal(call.body.stream_options.include_usage, true); assert.equal(call.body.max_tokens, 256); }
    await section(page, /^(请求样本|Request samples)/);
    assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 3);
    const statistics = await section(page, /^(性能统计|Performance statistics)$/);
    assert.match(await statistics.locator('.benchmark-summary').innerText(), /1,250/);
    const downloadEvent = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 JSON' }).click();
    const download = await downloadEvent, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.match(download.suggestedFilename(), /^strata-benchmark-.+\.json$/);
    assert.equal(exported.id, report.id); assert.equal(exported.summary.completed, 2);
    assert.equal(exported.summary.prefillTokS, 1250); assert.equal(exported.summary.decodeTokS, 80); assert.equal(exported.summary.cacheHitRate, 0.4);
    await page.reload(); await area(page).getByRole('heading', { name: /^(Benchmark 性能测试|Benchmark)$/ }).waitFor();
    await section(page, /^(请求样本|Request samples)/); await area(page).locator('.benchmark-samples-table tbody tr').first().waitFor();
    assert.equal((await reports(page))[0].id, report.id); assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 3);
  });
  await run('repeat-input-and-warmup-exclusion', async page => {
    await configure(page, { repeat: true }); await start(page); await finish(page);
    const [report] = await reports(page), calls = await streams(page);
    assert.equal(calls[0].body.messages[0].content, calls[1].body.messages[0].content);
    assert.equal(report.samples.length, 2); assert.equal(report.options.mode, 'repeat');
    assert.equal(report.options.mode, 'repeat');
  });
  await run('navigation-keeps-run-and-operation-interlocks', async page => {
    await configure(page); await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; }); await start(page);
    await page.waitForFunction(() => window.__fixture.benchmark.streams.length === 1);
    await navigate(page, 'usage');
    await area(page).waitFor({ state: 'hidden' });
    assert.equal(await area(page).isVisible(), false, 'Hidden benchmark stays mounted without rendering on another page');
    await navigate(page, 'models');
    const inactiveModel = page.locator('.service-manager-card[data-profile-id="b"]');
    await inactiveModel.getByRole('button', { name: '使用此配置', exact: true }).waitFor();
    assert.equal(await inactiveModel.getByRole('button', { name: '使用此配置', exact: true }).isDisabled(), true);
    assert.equal(await inactiveModel.getByRole('combobox').isDisabled(), true);
    await navigate(page, 'chat'); await page.locator('#input').waitFor(); await page.locator('#input').fill('should not send');
    assert.equal(await page.locator('#send-btn').isDisabled(), true);
    await navigate(page, 'tuning'); await page.getByRole('button', { name: '开始实测', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '开始实测', exact: true }).isDisabled(), true);
    await navigate(page, 'environment'); await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('button', { name: '更新至 0.1.2', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '更新至 0.1.2', exact: true }).isDisabled(), true);
    await navigate(page, 'benchmark'); await area(page).getByRole('button', { name: '停止测试' }).waitFor();
    assert.equal((await streams(page)).length, 1); assert.equal((await reports(page)).length, 0);
    await area(page).getByRole('button', { name: '停止测试' }).click(); await finish(page);
    const [report] = await reports(page); assert.equal(report.state, 'cancelled'); assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0].state, 'cancelled'); assert.equal(await page.evaluate(() => window.__fixture.benchmark.cancelled.length), 1);
    assert.match(await area(page).locator('.benchmark-result-meta').innerText(), /已停止/);
  });
  for (const [mode, label] of [['error', 'Synthetic benchmark failure'], ['incomplete', '中断'], ['hold', '超时']]) {
    await run(`failed-${mode}`, async page => {
      await configure(page, { rounds: 3, timeout: 1, stopOnError: true }); await page.evaluate(value => { window.__fixture.benchmark.mode = value; }, mode);
      await start(page); await finish(page);
      const [report] = await reports(page); assert.equal(report.state, 'failed'); assert.equal(report.samples.length, 1);
      assert.equal(report.samples[0].state, 'failed'); assert.match(report.samples[0].error, new RegExp(label));
      assert.equal((await streams(page)).length, 1); assert.match(await area(page).locator('.benchmark-result-meta').innerText(), /失败/);
      await section(page, /^(请求样本|Request samples)/);
      assert.match(await area(page).locator('.benchmark-sample-error').innerText(), new RegExp(label));
    });
  }
  await run('stopped-service-never-requests-inference', async page => {
    await area(page).getByText('未启动或模型未就绪', { exact: true }).waitFor();
    assert.equal(await area(page).getByRole('button', { name: '开始测试' }).isDisabled(), true);
    assert.equal((await streams(page)).length, 0);
  }, '?stopped=1');
  await run('preflight-rechecks-service-before-stream', async page => {
    await configure(page); await page.evaluate(() => { window.__fixture.benchmark.stopped = true; }); await start(page);
    await area(page).getByRole('alert').waitFor(); assert.match(await area(page).getByRole('alert').innerText(), /未启动/);
    assert.equal((await streams(page)).length, 0); assert.equal((await reports(page)).length, 0);
  });
  await run('external-load-blocks-benchmark-preflight', async page => {
    await configure(page);
    for (const live of [{ state: 'generating', queued: 0 }, { state: 'reading', queued: 0 }, { state: 'idle', waiting: 1 }, { state: 'idle', running: 1 }, { state: 'idle', queued: 1 }, { state: 'idle', admitting: 1 }]) {
      await page.evaluate(value => { window.__fixture.benchmark.live = value; }, live); await start(page);
      await area(page).getByRole('alert').waitFor(); assert.match(await area(page).getByRole('alert').innerText(), /空闲|推理|排队/);
      assert.equal((await streams(page)).length, 0); assert.equal((await reports(page)).length, 0);
    }
  });
  await run('all-scenarios-real-multiturn-cache-and-filter', async page => {
    await configure(page, { rounds: 2, warmup: true, scenarios: ['short', 'code', 'long', 'decode', 'cache', 'conversation'] });
    await area(page).getByRole('spinbutton', { name: '长输入字符数', exact: true }).fill('4096');
    await start(page); await finish(page);
    const [report] = await reports(page), calls = await streams(page);
    assert.equal(report.schemaVersion, 2); assert.equal(report.state, 'completed');
    assert.equal(report.samples.length, 22); assert.equal(calls.length, 22);
    assert.equal(report.samples.filter(sample => sample.warmup).length, 6);
    assert.deepEqual([...new Set(report.samples.map(sample => sample.scenario))], ['short', 'code', 'long', 'decode', 'cache', 'conversation']);
    const measuredConversations = report.samples.filter(sample => !sample.warmup && sample.scenario === 'conversation');
    assert.deepEqual(measuredConversations.map(sample => sample.turn), [1, 2, 3, 1, 2, 3]);
    const conversationCalls = calls.filter((call, index) => report.samples[index].scenario === 'conversation' && !report.samples[index].warmup);
    assert.deepEqual(conversationCalls.map(call => call.body.messages.length), [1, 3, 5, 1, 3, 5]);
    assert.match(conversationCalls[1].body.messages[1].content, /fixture output/);
    const cached = calls.filter((call, index) => report.samples[index].scenario === 'cache').map(call => call.body.messages[0].content);
    assert.equal(new Set(cached).size, 1, 'Cache scenario repeats identical input including warmup');
    assert.ok(report.samples.filter(sample => sample.scenario === 'long').every(sample => sample.inputChars >= 4096));
    await section(page, /^(请求样本|Request samples)/);
    await dropdown(page, '筛选场景', '多轮对话');
    assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 7);
    assert.match(await area(page).locator('.benchmark-summary-primary').innerText(), /P99/);
    const comparisons = await section(page, /^(场景与并发对比|Scenario and concurrency comparison)$/);
    assert.equal(await comparisons.locator('.benchmark-comparison').count(), 2);
  });
  await run('fixed-concurrency-mixed-errors-budget-json-csv', async page => {
    await stress(page); await page.evaluate(() => { window.__fixture.benchmark.errorEvery = 3; });
    await start(page); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.options.kind, 'stress'); assert.equal(report.stopReason, 'requestLimit');
    assert.equal(report.samples.length, 12); assert.equal(state.streams.length, 12);
    assert.equal(state.peak, 4); assert.equal(state.active, 0);
    assert.equal(report.samples.filter(sample => sample.state === 'failed').length, 4);
    let event = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 JSON', exact: true }).click();
    let download = await event, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.summary.completed, 8); assert.equal(exported.summary.failed, 4);
    assert.equal(exported.summary.aggregateOutputTokS, null, 'Missing output usage remains unknown');
    assert.equal(exported.summary.decodeTokS, 80); assert.ok(exported.summary.requestsPerSecond > 0);
    event = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 CSV', exact: true }).click();
    download = await event; const csv = await readFile(await download.path(), 'utf8');
    assert.equal(csv.trim().split('\r\n').length, 13); assert.match(csv, /error_code,http_status/); assert.match(csv, /"HTTP_ERROR","503"/);
  });
  await run('maximum-32-clients', async page => {
    await stress(page, { concurrency: 32, budget: 32 });
    await page.evaluate(() => { window.__fixture.benchmark.delayMs = 150; });
    await start(page); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(state.peak, 32); assert.equal(state.active, 0); assert.equal(state.streams.length, 32);
    assert.equal(report.samples.filter(sample => sample.state === 'completed').length, 32);
  });
  await run('ramp-duration-resources-and-bounded-sample-table', async page => {
    await stress(page, { pattern: 'ramp', duration: 16, budget: 5000 });
    await start(page); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'completed'); assert.equal(report.stopReason, 'duration');
    assert.deepEqual(report.stages.map(stage => stage.concurrency), [1, 2, 4]);
    for (let index = 1; index < report.stages.length; index++) assert.ok(report.stages[index].startedAt >= report.stages[index - 1].finishedAt);
    assert.ok(state.peak <= 4); assert.equal(state.active, 0);
    assert.ok(report.telemetry.length >= 3); assert.ok(report.telemetry.some(point => point.gpuMemoryUsed === 4 * 1024 ** 3));
    await section(page, /^(请求样本|Request samples)/);
    await section(page, /^(资源与排队趋势|Resources and queue trends)/);
    assert.ok(report.samples.length > 100); assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 100);
    assert.match(await area(page).locator('.benchmark-resource-latest').innerText(), /4 GiB/);
  });
  await run('cancel-all-stress-workers', async page => {
    await stress(page); await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; });
    await start(page); await page.waitForFunction(() => window.__fixture.benchmark.active === 4);
    assert.equal(await area(page).locator('.benchmark-plan-settings').isVisible(), false);
    await area(page).getByRole('heading', { name: '实时测试进度', exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, 'cancel-all-stress-workers-running.png'), fullPage: true });
    await area(page).getByRole('button', { name: '查看设置', exact: true }).click();
    assert.equal(await area(page).getByRole('checkbox').first().isDisabled(), true);
    await area(page).getByRole('button', { name: '收起设置', exact: true }).click();
    await area(page).getByRole('button', { name: '停止测试', exact: true }).click(); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'cancelled'); assert.equal(report.samples.length, 4);
    assert.ok(report.samples.every(sample => sample.state === 'cancelled'));
    assert.equal(state.cancelled.length, 4); assert.equal(state.active, 0);
  });
  await run('model-change-stops-all-workers', async page => {
    await stress(page); await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; });
    await start(page); await page.waitForFunction(() => window.__fixture.benchmark.active === 4);
    await page.evaluate(() => { window.__fixture.benchmark.model = 'Fixture B'; }); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'failed'); assert.equal(report.stopReason, 'modelChanged');
    assert.equal(state.active, 0); assert.equal(state.cancelled.length, 4);
  });
  await run('legacy-history-remains-readable-and-exportable', async page => {
    const old = { id: 'legacy-report', profileId: 'a', profileName: 'Fixture A', baseUrl: 'http://127.0.0.1:18081', model: 'Fixture A', startedAt: 1700000000000, finishedAt: 1700000000100, state: 'completed', options: { prompt: 'old', rounds: 1, maxTokens: 256, warmup: false, mode: 'repeat', timeoutMs: 5000 }, samples: [{ index: 1, warmup: false, model: 'Fixture A', startedAt: 1700000000000, state: 'completed', wallMs: 100, ttftMs: 20, promptTokens: 100, completionTokens: 10, cachedTokens: 40, prefillTokS: 1250, decodeTokS: 80, output: 'legacy output' }] };
    await page.evaluate(value => localStorage.setItem('benchmark-fixture-reports', JSON.stringify([value])), old);
    await page.reload(); await area(page).getByText('旧版串行报告', { exact: false }).waitFor();
    await section(page, /^(请求样本|Request samples)/);
    assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 1);
    const event = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 JSON', exact: true }).click();
    const downloaded = JSON.parse(await readFile(await (await event).path(), 'utf8'));
    assert.equal(downloaded.id, old.id); assert.equal(downloaded.summary.completed, 1); assert.equal((await streams(page)).length, 0);
  });
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1800, height: 1200 }]) await run(`compact-default-first-screen-${viewport.width}`, async page => {
    await assertFirstScreen(page);
    assert.equal(await area(page).getByRole('checkbox').evaluateAll(elements => elements.filter(element => element.checked).length), 6);
    await page.screenshot({ path: resolve(output, `compact-default-suite-${viewport.width}.png`), fullPage: false });
    await area(page).getByRole('radio', { name: '压力测试', exact: true }).click();
    await assertFirstScreen(page);
    assert.equal(await area(page).getByRole('button', { name: '轻量试跑', exact: true }).isVisible(), true);
    assert.match(await area(page).locator('.benchmark-budget').innerText(), /300 个请求或 300 秒/);
    await page.screenshot({ path: resolve(output, `compact-default-stress-${viewport.width}.png`), fullPage: false });
    await area(page).getByRole('button', { name: '测试说明', exact: true }).click();
    const guide = page.getByRole('dialog', { name: 'Benchmark 测试说明', exact: true });
    await guide.waitFor(); assert.equal(await guide.locator('dt').count(), 7);
    assert.match(await guide.innerText(), /单路引擎|排队/);
    await page.keyboard.press('Escape'); await guide.waitFor({ state: 'hidden' });
    assert.equal((await streams(page)).length, 0);
  }, '', viewport);
  for (const language of ['zh-CN', 'en']) await run(`narrow-layout-${language}`, async page => {
    const toggle = page.getByRole('button', { name: /^(收起侧栏|Collapse sidebar)$/ });
    if (await toggle.count()) await toggle.click();
    await page.screenshot({ path: resolve(output, `narrow-layout-${language}-plan.png`), fullPage: false });
    await configure(page, { rounds: 1 });
    // Resource telemetry ticks every two seconds; synthetic SSE has two delays.
    await page.evaluate(() => { window.__fixture.benchmark.delayMs = 1200; });
    await start(page); await finish(page);
    await area(page).locator('.benchmark-summary-primary').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `narrow-layout-${language}-results.png`), fullPage: true });
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, table: document.querySelector('.benchmark-page .table-wrap').scrollWidth }));
    assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1, JSON.stringify(widths));
    assert.equal(await area(page).getByRole('button', { name: language === 'en' ? 'Export JSON' : '导出 JSON' }).isEnabled(), true);
    await section(page, /^(性能统计|Performance statistics)$/);
    await section(page, /^(请求样本|Request samples)/);
    await section(page, /^(资源与排队趋势|Resources and queue trends)/);
    const expandedWidths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(expandedWidths.document <= expandedWidths.viewport + 1 && expandedWidths.body <= expandedWidths.viewport + 1, JSON.stringify(expandedWidths));
    await page.screenshot({ path: resolve(output, `narrow-layout-${language}-expanded.png`), fullPage: true });
    if (language === 'en') assert.match(await area(page).locator('.benchmark-section .benchmark-summary').innerText(), /Mean TTFT/);
  }, `?language=${language}`, { width: 480, height: 1000 });
} finally { await browser?.close(); await server.close(); }
const resultName = selectedCase ? `browser-results-${selectedCase.replace(/[^a-z0-9-]/gi, '')}.json` : 'browser-results.json';
await writeFile(resolve(output, resultName), JSON.stringify({ scope: 'Real React App with synthetic native SSE and isolated storage. No supervisor, model or GPU acceptance.', fixtureOrigin: origin, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
