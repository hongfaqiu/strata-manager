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
const area = page => page.locator('.benchmark-page:visible');
async function scenario(page) {
  await page.getByRole('radio', { name: /^(场景测试|Scenario suite)$/, exact: true }).click();
  await area(page).getByRole('heading', { name: /^(场景测试|Scenario tests)$/ }).waitFor();
}
async function navigate(page, hash) {
  const labels = { models: '模型', chat: '聊天', tuning: '参数调优', environment: 'Strata', monitoring: '监控' };
  if (hash === 'benchmark') {
    await page.locator('.manager-nav').getByRole('button', { name: 'Benchmark 测试', exact: true }).click();
  } else if (hash === 'usage') {
    await page.locator('.manager-nav').getByRole('button', { name: '监控', exact: true }).click();
    await page.locator('.workspace-subnav').getByRole('button', { name: 'API 使用统计', exact: true }).click();
  }
  else await page.locator('.manager-nav').getByRole('button', { name: labels[hash], exact: true }).click();
  await page.waitForFunction(value => location.hash === `#${value}`, hash);
}
async function streams(page) { return page.evaluate(() => window.__fixture.benchmark.streams); }
async function reports(page) { return page.evaluate(() => window.__fixture.store.benchmarkReportsV1 ?? []); }
async function contextReports(page) { return page.evaluate(() => window.__fixture.store.contextBenchmarkReportsV1 ?? []); }
async function tierState(page) { return area(page).getByRole('checkbox').evaluateAll(inputs => inputs.map(input => ({ label: input.closest('label').innerText.trim(), checked: input.checked, disabled: input.disabled }))); }
async function waitForTierSelection(page, count) { await page.waitForFunction(expected => [...document.querySelectorAll('.context-benchmark-page input[type="checkbox"]')].filter(input => input.checked).length === expected, count); }
async function finish(page) { await page.waitForFunction(() => !!window.__fixture.store.benchmarkReportsV1?.length, undefined, { timeout: 60000 }); await area(page).getByRole('button', { name: /^(开始测试|Start benchmark)$/ }).waitFor(); }
async function finishContext(page) { await page.waitForFunction(() => !!window.__fixture.store.contextBenchmarkReportsV1?.length, undefined, { timeout: 60000 }); await area(page).getByRole('button', { name: /^(开始测试|Start benchmark)$/ }).waitFor(); }
async function chooseScenarios(page, ids) {
  const names = { short: /^(短问答|Short answer)$/, code: /^(代码审查|Code review)$/, long: /^(长输入|Long input)$/, decode: /^(持续生成|Sustained generation)$/, cache: /^(重复输入缓存|Repeated input cache)$/, conversation: /^(多轮对话|Conversation)$/, custom: /^(自定义|Custom)$/ };
  for (const [id, name] of Object.entries(names)) await area(page).getByRole('checkbox', { name, exact: true }).setChecked(ids.includes(id));
}
// Every scenario setting and result section is shown directly; nothing is folded.
async function section(page, label) {
  const heading = area(page).locator('.scenario-section > h3').filter({ hasText: label });
  await heading.waitFor();
  assert.equal(await heading.count(), 1, `One section matches ${label}`);
  return heading.locator('..');
}
async function assertNothingFolded(page) {
  assert.equal(await page.locator('.scenario-benchmark-page details').count(), 0, 'The scenario page has no collapsible sections');
}
async function assertFirstScreen(page) {
  const button = area(page).getByRole('button', { name: /^(开始测试|Start benchmark)$/ });
  const bounds = await button.boundingBox(), viewport = page.viewportSize();
  assert.ok(bounds && viewport && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `Start action fits first screen: ${JSON.stringify({ bounds, viewport })}`);
  assert.equal(await area(page).locator('.benchmark-plan').getByRole('checkbox').count(), 7);
  await assertNothingFolded(page);
  for (const name of [/^(每轮超时（秒）|Timeout per request \(seconds\))$/, /^(测试轮数|Rounds per scenario)$/]) assert.equal(await area(page).getByRole('spinbutton', { name }).isVisible(), true, 'Key settings are visible without expanding');
  assert.equal(await area(page).getByRole('combobox', { name: /^(输入模式|Input mode)$/ }).isVisible(), true);
  assert.equal(await area(page).locator('.benchmark-scenario small').count(), 0, 'Scene explanations are on demand');
}
async function assertContextResultActions(page, hasHistory = true) {
  assert.equal(await area(page).locator('.page-header').getByRole('button').count(), 0, 'The context page title has no actions');
  for (const name of [/^(导出 PNG|Export PNG)$/, /^(导出 JSON|Export JSON)$/, /^(导出 CSV|Export CSV)$/, /^(测试说明|Test guide)$/]) {
    assert.equal(await area(page).getByRole('button', { name, exact: true }).count(), 0, 'Removed context actions do not appear');
  }
  const header = area(page).locator('.benchmark-results > .panel-header');
  const copy = header.getByRole('button', { name: /^(复制图片|Copy image)$/, exact: true });
  const history = header.getByRole('combobox', { name: /^(上下文测试历史|Context benchmark history)$/, exact: true });
  assert.equal(await copy.count(), 1, 'Copy belongs to the result panel');
  assert.equal(await history.count(), Number(hasHistory));
  const copyBounds = await copy.boundingBox(), headerBounds = await header.boundingBox();
  assert.ok(copyBounds && headerBounds, 'Result actions are visible');
  if (hasHistory) {
    assert.ok(await header.evaluate(element => {
      const button = element.querySelector('button'), combobox = element.querySelector('[role="combobox"]');
      return !!button && !!combobox && !!(button.compareDocumentPosition(combobox) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'Copy precedes the result history dropdown');
    if (page.viewportSize().width >= 700) {
      const historyBounds = await history.boundingBox();
      assert.ok(historyBounds && copyBounds.x + copyBounds.width <= historyBounds.x + 1, 'Copy appears to the left of history');
    }
  } else {
    assert.equal(await copy.isDisabled(), true, 'Copy waits for a completed report');
    assert.ok(Math.abs(copyBounds.x + copyBounds.width - headerBounds.x - headerBounds.width) <= 1, 'Copy stays at the right edge without history');
  }
}
async function dropdown(page, label, option) {
  await area(page).getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function configure(page, { rounds = 2, timeout = 5, warmup = false, repeat = false, scenarios = ['custom'], stopOnError = false } = {}) {
  await chooseScenarios(page, scenarios);
  await area(page).getByRole('spinbutton', { name: /^(测试轮数|Rounds per scenario)$/ }).fill(String(rounds));
  await area(page).getByRole('spinbutton', { name: /^(每轮超时（秒）|Timeout per request \(seconds\))$/ }).fill(String(timeout));
  if (warmup) await area(page).getByRole('switch', { name: /^(先预热一次|Run one warmup)$/ }).click();
  if (repeat) await dropdown(page, /^(输入模式|Input mode)$/, /^(重复输入 · 测试缓存|Repeated input · cache test)$/);
  if (stopOnError) await area(page).getByRole('switch', { name: /^(发生错误后停止|Stop on error)$/ }).click();
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
    await area(page).getByRole('heading', { name: /^(上下文档位实测|Context tier benchmark)$/ }).waitFor();
    if (!name.startsWith('context-')) await scenario(page);
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
  await run('context-default-tiers-serial-resources-history-actions', async page => {
    const navigation = page.locator('.manager-nav').getByRole('button', { name: 'Benchmark 测试', exact: true });
    assert.equal(await navigation.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.workspace-subnav').count(), 0);
    assert.equal(await page.getByRole('radio', { name: '上下文档位', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('radio', { name: /压力测试|Stress test/ }).count(), 0);
    assert.equal(await page.getByRole('spinbutton', { name: /并发|Concurrency/ }).count(), 0);
    await assertContextResultActions(page, false);
    assert.equal(await area(page).getByRole('spinbutton', { name: '最大输出 token', exact: true }).inputValue(), '512');
    await waitForTierSelection(page, 2);
    const tiers = await tierState(page);
    assert.deepEqual(tiers.filter(tier => tier.checked).map(tier => tier.label), ['8K', '32K']);
    assert.ok(tiers.filter(tier => !tier.checked).every(tier => tier.disabled), 'Every tier above model capacity is unavailable');
    await area(page).getByRole('textbox', { name: '测试配置名称', exact: true }).fill('Synthetic 32K');
    await start(page); await finishContext(page);
    const [report] = await contextReports(page), calls = await streams(page);
    assert.equal(report.schemaVersion, 3); assert.equal(report.state, 'completed');
    assert.equal(await area(page).locator('.notice.error').count(), 0, 'A successful run does not display an error notice');
    assert.equal(report.options.configurationLabel, 'Synthetic 32K');
    assert.deepEqual(report.samples.map(sample => sample.targetTokens), [8192, 32768]);
    assert.deepEqual(report.skippedTiers, []);
    assert.equal(calls.length, 2); assert.equal(await page.evaluate(() => window.__fixture.benchmark.peak), 1);
    for (const sample of report.samples) {
      assert.equal(sample.tokenCountMethod, 'count_tokens'); assert.equal(sample.promptTokens, sample.countedPromptTokens);
      assert.ok(sample.promptTokens <= sample.targetTokens - 576 && sample.promptTokens >= (sample.targetTokens - 576) * 0.99);
      assert.equal(sample.completionTokens, 512); assert.equal(sample.cachedTokens, 0);
      assert.equal(sample.prefillTokS, 1250); assert.equal(sample.decodeTokS, 80);
      assert.equal(sample.peakGpuMemory, 4 * 1024 ** 3); assert.equal(sample.minGpuMemoryFree, 4 * 1024 ** 3); assert.equal(sample.peakRam, 8 * 1024 ** 3);
      assert.ok(sample.resourceSamples >= 2); assert.ok(sample.ttftMs >= 0 && sample.ttftMs < sample.wallMs);
    }
    for (const call of calls) { assert.equal(call.body.temperature, 0); assert.equal(call.body.reasoning_effort, 'none'); assert.equal(call.body.max_tokens, 512); }
    assert.equal(new Set(calls.map(call => call.body.messages[0].content.split('\n')[0])).size, 2, 'Each tier uses a distinct prefix');
    assert.equal(await area(page).locator('.context-benchmark-table tbody tr').count(), 2);
    const firstRow = area(page).locator('.context-benchmark-table tbody tr').first();
    assert.match(await firstRow.innerText(), /Synthetic 32K/); assert.match(await firstRow.innerText(), /4,096/);
    assert.equal(await area(page).locator('.context-benchmark-chart').count(), 3);
    assert.equal(await area(page).locator('.context-benchmark-chart--prefill .context-benchmark-point').count(), 2);
    assert.match(await area(page).locator('.context-benchmark-chart--prefill').textContent(), /1,250/);
    assert.match(await area(page).locator('.context-benchmark-chart--decode').textContent(), /80/);
    assert.equal(await area(page).locator('details:not(.benchmark-result-meta)').count(), 0);
    await assertContextResultActions(page);
    assert.equal(await area(page).getByRole('button', { name: '复制图片', exact: true }).isEnabled(), true);
    await page.reload(); await area(page).getByRole('heading', { name: '上下文档位实测', exact: true }).waitFor();
    await area(page).locator('.context-benchmark-table tbody tr').nth(1).waitFor();
    assert.equal((await contextReports(page))[0].id, report.id);
    await assertContextResultActions(page);
  }, '', { width: 1366, height: 768 });
  await run('context-unknown-capacity-never-infer', async page => {
    await area(page).getByRole('alert').waitFor();
    assert.equal(await area(page).getByRole('button', { name: '开始测试', exact: true }).isDisabled(), true);
    const tiers = await tierState(page);
    assert.ok(tiers.every(tier => tier.disabled && !tier.checked));
    assert.equal((await streams(page)).length, 0); assert.equal(await page.evaluate(() => window.__fixture.contextBenchmark.counts.length), 0);
  }, '?maxContext=0');
  await run('context-1m-default-all-tiers', async page => {
    await waitForTierSelection(page, 9);
    const tiers = await tierState(page);
    assert.deepEqual(tiers.map(tier => tier.label), ['8K', '32K', '64K', '128K', '256K', '384K', '512K', '768K', '1M']);
    assert.ok(tiers.every(tier => tier.checked && !tier.disabled), JSON.stringify(tiers));
    assert.match(await area(page).locator('.context-benchmark-capacity').innerText(), /1M/);
    assert.equal((await streams(page)).length, 0);
  }, '?maxContext=1048576');
  await run('context-nonstandard-max-and-capacity-reset', async page => {
    await waitForTierSelection(page, 9);
    await waitForTierSelection(page, 9); const initial = await tierState(page);
    assert.equal(initial.find(tier => tier.label === '1,000,000').checked, true);
    assert.equal(initial.find(tier => tier.label === '1M').disabled, true);
    await area(page).getByRole('checkbox', { name: '8K', exact: true }).uncheck();
    await page.evaluate(() => { window.__fixture.contextBenchmark.maxContext = 16384; window.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await waitForTierSelection(page, 2);
    const changed = await tierState(page);
    assert.deepEqual(changed.filter(tier => tier.checked).map(tier => tier.label), ['8K', '16K']);
    assert.equal(changed.find(tier => tier.label === '32K').disabled, true);
    assert.equal((await streams(page)).length, 0);
  }, '?maxContext=1000000');
  await run('context-profile-switch-resets-default-tiers', async page => {
    await waitForTierSelection(page, 2);
    await area(page).getByRole('checkbox', { name: '8K', exact: true }).uncheck();
    await page.evaluate(() => { window.__fixture.contextBenchmark.runningProfiles.push('b'); });
    await navigate(page, 'models');
    await page.locator('.service-manager-card[data-profile-id="b"]').getByRole('button', { name: '使用此配置', exact: true }).click();
    await navigate(page, 'benchmark'); await waitForTierSelection(page, 3);
    const tiers = await tierState(page);
    assert.deepEqual(tiers.filter(tier => tier.checked).map(tier => tier.label), ['8K', '32K', '64K']);
    assert.match(await area(page).locator('.benchmark-service').innerText(), /Fixture B/);
    assert.equal((await streams(page)).length, 0);
  });
  await run('context-output-budget-removes-too-small-selection', async page => {
    await waitForTierSelection(page, 1);
    await waitForTierSelection(page, 1); assert.deepEqual((await tierState(page)).filter(tier => tier.checked).map(tier => tier.label), ['2K']);
    await area(page).getByRole('spinbutton', { name: '最大输出 token', exact: true }).fill('2048');
    await waitForTierSelection(page, 0);
    assert.ok((await tierState(page)).every(tier => !tier.checked && tier.disabled));
    assert.equal(await area(page).getByRole('button', { name: '开始测试', exact: true }).isDisabled(), true);
    assert.equal((await streams(page)).length, 0);
  }, '?maxContext=2048');
  await run('context-estimated-input-clearly-marked', async page => {
    await page.evaluate(() => { window.__fixture.contextBenchmark.countUnavailable = true; });
    await start(page); await finishContext(page);
    const [report] = await contextReports(page);
    assert.equal(report.samples.length, 2); assert.ok(report.samples.every(sample => sample.tokenCountMethod === 'estimated' && sample.countedPromptTokens === null));
    assert.equal(await area(page).locator('details:not(.benchmark-result-meta)').count(), 0);
    await assertContextResultActions(page);
  });
  await run('context-navigation-keeps-runner-and-stop', async page => {
    await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; });
    await start(page); await page.waitForFunction(() => window.__fixture.benchmark.active === 1);
    assert.equal(await page.getByRole('radio', { name: '场景测试', exact: true }).isDisabled(), true);
    assert.equal(await area(page).getByRole('checkbox').first().isDisabled(), true);
    await navigate(page, 'usage'); assert.equal(await area(page).count(), 0);
    assert.equal(await page.locator('.context-benchmark-page').count(), 1, 'The context runner stays mounted');
    assert.equal(await page.locator('.workspace-subnav').getByRole('button', { name: 'Benchmark 测试', exact: true }).count(), 0);
    await navigate(page, 'chat'); assert.equal(await page.locator('#send-btn').isDisabled(), true);
    await navigate(page, 'benchmark'); await area(page).getByRole('button', { name: '停止测试', exact: true }).click();
    await finishContext(page);
    const [report] = await contextReports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'cancelled'); assert.equal(report.samples.length, 1); assert.equal(report.samples[0].state, 'cancelled');
    assert.equal(state.cancelled.length, 1); assert.equal(state.active, 0); assert.equal(state.streams.length, 1);
    assert.equal(await page.getByRole('radio', { name: '场景测试', exact: true }).isEnabled(), true);
  });
  for (const language of ['zh-CN', 'en']) await run(`context-narrow-layout-${language}`, async page => {
    await page.getByRole('button', { name: /^(收起侧栏|Collapse sidebar)$/ }).click();
    await start(page); await finishContext(page);
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1, JSON.stringify(widths));
    assert.equal(await area(page).locator('.context-benchmark-table tbody tr').count(), 2);
    await assertContextResultActions(page);
    assert.equal(await area(page).getByRole('button', { name: language === 'en' ? 'Copy image' : '复制图片', exact: true }).isEnabled(), true);
  }, `?language=${language}`, { width: 480, height: 1000 });
  await run('serial-sse-metrics-history-export', async page => {
    const checkboxStyle = await area(page).getByRole('checkbox', { name: '短问答', exact: true }).evaluate(element => ({ checked: element.checked, padding: getComputedStyle(element).padding, appearance: getComputedStyle(element).appearance, whiteCheck: getComputedStyle(element).backgroundImage.includes('fff') }));
    assert.deepEqual(checkboxStyle, { checked: true, padding: '0px', appearance: 'none', whiteCheck: true });
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
    assert.match(await area(page).locator('.benchmark-summary-primary').innerText(), /1,250/);
    assert.equal(await area(page).locator('.scenario-plot').filter({ hasText: /输出速度/ }).locator('.scenario-plot-dot').count(), 2, 'Warmup is excluded from per-request dots');
    assert.match(await area(page).locator('.scenario-output').first().innerText(), /fixture output/);
    await assertNothingFolded(page);
    const downloadEvent = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 JSON' }).click();
    const download = await downloadEvent, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.match(download.suggestedFilename(), /^strata-benchmark-.+\.json$/);
    assert.equal(exported.id, report.id); assert.equal(exported.summary.completed, 2);
    assert.equal(exported.summary.prefillTokS, 1250); assert.equal(exported.summary.decodeTokS, 80); assert.equal(exported.summary.cacheHitRate, 0.4);
    await page.reload(); await scenario(page);
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
    const benchmarkNavigation = page.locator('.manager-nav').getByRole('button', { name: 'Benchmark 测试', exact: true });
    assert.equal(await benchmarkNavigation.getAttribute('aria-current'), 'page', 'Benchmark has its own active sidebar item');
    assert.equal(await page.locator('.workspace-subnav').count(), 0, 'Benchmark is a standalone workspace');
    await configure(page); await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; }); await start(page);
    await page.waitForFunction(() => window.__fixture.benchmark.streams.length === 1);
    await navigate(page, 'usage');
    await area(page).waitFor({ state: 'hidden' });
    assert.equal(await area(page).count(), 0, 'Hidden benchmark does not render on another page');
    assert.equal(await page.locator('.benchmark-page:not(.context-benchmark-page)').count(), 1, 'The active scenario runner remains mounted after navigation');
    assert.equal(await page.locator('.workspace-subnav').getByRole('button', { name: 'Benchmark 测试', exact: true }).count(), 0, 'Monitoring does not contain Benchmark');
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
    assert.equal(await benchmarkNavigation.getAttribute('aria-current'), 'page');
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
    assert.equal(report.schemaVersion, 3); assert.equal(report.state, 'completed');
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
    const comparisons = await section(page, /^(分场景对比|Scenario comparison)$/);
    assert.equal(await comparisons.locator('tbody tr').count(), 6);
    assert.equal(await comparisons.locator('.scenario-columns').count(), 2);
    assert.equal(await comparisons.locator('.scenario-columns').first().locator('rect').count(), 6);
    assert.match(await section(page, /^(测试条件|Test conditions)/).then(element => element.innerText()), /多轮对话/);
  });
  await run('serial-mixed-errors-json-csv', async page => {
    await configure(page, { rounds: 12, scenarios: ['short'] });
    await page.evaluate(() => { window.__fixture.benchmark.errorEvery = 3; });
    await start(page); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.options.kind, 'suite'); assert.equal(report.options.concurrency, 1);
    assert.equal(report.samples.length, 12); assert.equal(state.streams.length, 12);
    assert.equal(state.peak, 1); assert.equal(state.active, 0);
    assert.equal(report.samples.filter(sample => sample.state === 'failed').length, 4);
    let event = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 JSON', exact: true }).click();
    let download = await event, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.summary.completed, 8); assert.equal(exported.summary.failed, 4);
    assert.equal(exported.summary.decodeTokS, 80);
    event = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 CSV', exact: true }).click();
    download = await event; const csv = await readFile(await download.path(), 'utf8');
    assert.equal(csv.trim().split('\r\n').length, 13); assert.match(csv, /error_code,http_status/); assert.match(csv, /"HTTP_ERROR","503"/);
  });
  await run('serial-resource-telemetry-and-bounded-sample-table', async page => {
    await configure(page, { rounds: 20, scenarios: ['short', 'code', 'long', 'decode', 'cache', 'conversation'] });
    await page.evaluate(() => { window.__fixture.benchmark.delayMs = 10; });
    await start(page); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'completed'); assert.equal(report.stopReason, 'completed');
    assert.equal(state.peak, 1); assert.equal(state.active, 0);
    assert.ok(report.telemetry.length >= 2); assert.ok(report.telemetry.some(point => point.gpuMemoryUsed === 4 * 1024 ** 3));
    await section(page, /^(请求样本|Request samples)/);
    await area(page).locator('.benchmark-resources').waitFor();
    assert.ok(report.samples.length > 100); assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 100);
    assert.match(await area(page).locator('.benchmark-resource-latest').innerText(), /4 GiB/);
  });
  await run('cancel-serial-runner', async page => {
    await configure(page); await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; });
    await start(page); await page.waitForFunction(() => window.__fixture.benchmark.active === 1);
    await area(page).getByRole('heading', { name: '实时测试进度', exact: true }).waitFor();
    assert.equal(await area(page).locator('.benchmark-plan').getByRole('checkbox').count(), 0, 'Running replaces the editable plan with a read-only summary');
    assert.match(await area(page).locator('.scenario-running-plan').innerText(), /自定义[\s\S]*每个场景 2 轮[\s\S]*超时 5 秒/);
    await page.waitForFunction(() => /首 token .* 已接收 \d+ 字符/.test(document.querySelector('.scenario-live-now')?.textContent ?? ''));
    assert.match(await area(page).locator('.scenario-live-now strong').innerText(), /^自定义$/);
    assert.match(await area(page).locator('.scenario-tracker .is-active').innerText(), /自定义[\s\S]*0 \/ 2/);
    assert.equal(await area(page).locator('.scenario-steps .is-current').count(), 1);
    await assertNothingFolded(page);
    await area(page).getByRole('button', { name: '停止测试', exact: true }).click(); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'cancelled'); assert.equal(report.samples.length, 1);
    assert.ok(report.samples.every(sample => sample.state === 'cancelled'));
    assert.equal(state.cancelled.length, 1); assert.equal(state.active, 0);
  });
  await run('model-change-stops-serial-runner', async page => {
    await configure(page); await page.evaluate(() => { window.__fixture.benchmark.mode = 'hold'; });
    await start(page); await page.waitForFunction(() => window.__fixture.benchmark.active === 1);
    await page.evaluate(() => { window.__fixture.benchmark.model = 'Fixture B'; }); await finish(page);
    const [report] = await reports(page), state = await page.evaluate(() => window.__fixture.benchmark);
    assert.equal(report.state, 'failed'); assert.equal(report.stopReason, 'modelChanged');
    assert.equal(state.active, 0); assert.equal(state.cancelled.length, 1);
  });
  await run('legacy-history-remains-readable-and-exportable', async page => {
    const old = { id: 'legacy-report', profileId: 'a', profileName: 'Fixture A', baseUrl: 'http://127.0.0.1:18081', model: 'Fixture A', startedAt: 1700000000000, finishedAt: 1700000000100, state: 'completed', options: { prompt: 'old', rounds: 1, maxTokens: 256, warmup: false, mode: 'repeat', timeoutMs: 5000 }, samples: [{ index: 1, warmup: false, model: 'Fixture A', startedAt: 1700000000000, state: 'completed', wallMs: 100, ttftMs: 20, promptTokens: 100, completionTokens: 10, cachedTokens: 40, prefillTokS: 1250, decodeTokS: 80, output: 'legacy output' }] };
    await page.evaluate(value => localStorage.setItem('benchmark-fixture-reports', JSON.stringify([value])), old);
    await page.reload(); await scenario(page); await area(page).getByText('旧版串行报告', { exact: false }).waitFor();
    await section(page, /^(请求样本|Request samples)/);
    assert.equal(await area(page).locator('.benchmark-samples-table tbody tr').count(), 1);
    const event = page.waitForEvent('download'); await area(page).getByRole('button', { name: '导出 JSON', exact: true }).click();
    const downloaded = JSON.parse(await readFile(await (await event).path(), 'utf8'));
    assert.equal(downloaded.id, old.id); assert.equal(downloaded.summary.completed, 1); assert.equal((await streams(page)).length, 0);
  });
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1800, height: 1200 }]) await run(`compact-default-first-screen-${viewport.width}`, async page => {
    await assertFirstScreen(page);
    assert.equal(await area(page).locator('.benchmark-plan').getByRole('checkbox').evaluateAll(elements => elements.filter(element => element.checked).length), 6);
    await page.screenshot({ path: resolve(output, `compact-default-suite-${viewport.width}.png`), fullPage: false });
    await area(page).getByRole('button', { name: '测试说明', exact: true }).click();
    const guide = page.getByRole('dialog', { name: '场景测试说明', exact: true });
    await guide.waitFor(); assert.equal(await guide.locator('dt').count(), 7);
    assert.match(await guide.innerText(), /一次只发送一个请求/);
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
    await area(page).locator('.benchmark-summary-primary').scrollIntoViewIfNeeded(); await assertNothingFolded(page);
    await page.screenshot({ path: resolve(output, `narrow-layout-${language}-results.png`), fullPage: true });
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, table: document.querySelector('.benchmark-page .table-wrap').scrollWidth }));
    assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1, JSON.stringify(widths));
    assert.equal(await area(page).getByRole('button', { name: language === 'en' ? 'Export JSON' : '导出 JSON' }).isEnabled(), true);
    await section(page, /^(请求样本|Request samples)/);
    await section(page, /^(测试条件|Test conditions)/);
    await area(page).locator('.benchmark-resources').waitFor();
    const expandedWidths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(expandedWidths.document <= expandedWidths.viewport + 1 && expandedWidths.body <= expandedWidths.viewport + 1, JSON.stringify(expandedWidths));
    await page.screenshot({ path: resolve(output, `narrow-layout-${language}-expanded.png`), fullPage: true });
    if (language === 'en') assert.match(await area(page).locator('.benchmark-summary-primary').innerText(), /Mean TTFT/);
  }, `?language=${language}`, { width: 480, height: 1000 });
} finally { await browser?.close(); await server.close(); }
const resultName = selectedCase ? `browser-results-${selectedCase.replace(/[^a-z0-9-]/gi, '')}.json` : 'browser-results.json';
await writeFile(resolve(output, resultName), JSON.stringify({ scope: 'Real React App with synthetic native SSE and isolated storage. No supervisor, model or GPU acceptance.', fixtureOrigin: origin, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
