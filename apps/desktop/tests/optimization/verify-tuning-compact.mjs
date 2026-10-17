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
  title: 'Measure tuning on this computer', purpose: 'How do you mainly use the model?', mode: 'Test mode', quick: 'Quick calibration', full: 'Scenario verification', diagnostic: 'Short diagnostics',
  rounds: 'Repeated rounds', quickRounds: 'Repeat each value', context: 'Context limit for this test', tokens: 'Output limit per request', start: 'Start measurement', cancel: 'Cancel test',
  startQuick: 'Start quick calibration', cancelQuick: 'Cancel calibration', saveVersion: 'Save as new config version', overwrite: 'Overwrite current config', confirmOverwrite: 'Overwrite and save',
  verify: 'Verify with scenarios', benchmark: 'Run Benchmark', saved: 'New config version saved', noChange: 'The current values are already the fastest. Nothing to change.', amdZero: 'Skipped 0 on AMD',
  running: 'Measuring', canceled: 'Canceled', progress: 'Measurement progress', recovery: 'Configuration and service recovery',
  pending: 'Recovery record saved', failure: 'Recovery failed; repair required', apply: 'Apply and verify', restore: 'Restore original parameters',
  short: 'Short chat', chinese: 'Long Chinese response', worker: 'Compare CPU worker count', agent: 'Coding and Agent', noVision: 'Not tested',
  sceneResults: 'Scenario results', comparisons: 'Candidate comparison', workloadDetails: 'Complete workload details', diagnosticDetails: 'Short request measurement details',
} : {
  title: '为这台电脑实测调优', purpose: '你主要怎样使用模型？', mode: '测试模式', quick: '快速校准', full: '场景验收', diagnostic: '短请求诊断',
  rounds: '重复轮数', quickRounds: '每个值重复', context: '本次上下文上限', tokens: '每次输出上限', start: '开始实测', cancel: '取消测试',
  startQuick: '开始快速校准', cancelQuick: '取消校准', saveVersion: '另存为新配置版本', overwrite: '覆盖当前配置', confirmOverwrite: '覆盖并保存',
  verify: '用场景验收复核', benchmark: '运行 Benchmark', saved: '已保存新配置版本', noChange: '当前参数已经是最快的，无需修改。', amdZero: 'AMD 显卡跳过 0',
  running: '测量中', canceled: '已取消', progress: '测量进度', recovery: '配置与服务恢复',
  pending: '已保存恢复记录', failure: '恢复失败，需要修复', apply: '应用并验证', restore: '恢复原参数',
  short: '短对话', chinese: '中文长回答', worker: '比较 CPU 工作线程', agent: '编程与 Agent', noVision: '未测试',
  sceneResults: '场景结果', comparisons: '候选比较', workloadDetails: '完整任务明细', diagnosticDetails: '短请求测量明细',
};
async function insideFirstScreen(locator, page, name) {
  assert.equal(await locator.isVisible(), true, `${name} is visible`);
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert.ok(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width, `${name} fits first screen: ${JSON.stringify({ box, viewport })}`);
}
async function noFolding(page) {
  assert.equal(await area(page).locator('details, summary').count(), 0, 'No <details> folding anywhere on the tuning page');
}
async function firstScreen(page, language) {
  const text = labels(language);
  await insideFirstScreen(area(page).getByRole('radiogroup', { name: text.mode }), page, text.mode);
  assert.equal(await area(page).getByRole('radio', { name: text.quick, exact: true }).getAttribute('aria-checked'), 'true', 'Quick calibration is the default mode');
  await insideFirstScreen(area(page).getByRole('combobox', { name: text.quickRounds, exact: true }), page, text.quickRounds);
  await insideFirstScreen(area(page).getByRole('button', { name: text.startQuick, exact: true }), page, text.startQuick);
  await noFolding(page);
}
async function fullMode(page, language) {
  const text = labels(language);
  await area(page).getByRole('radio', { name: text.full, exact: true }).click();
  for (const name of [text.purpose, text.rounds, text.context]) await insideFirstScreen(area(page).getByRole('combobox', { name, exact: true }), page, name);
  await insideFirstScreen(area(page).getByRole('button', { name: text.start, exact: true }), page, text.start);
  await noFolding(page);
}
async function choose(page, name, value) {
  await area(page).getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
const advanced = page => area(page).locator('.tuning-advanced');
async function section(page, name) {
  const panel = area(page).locator('section.panel').filter({ has: page.getByRole('heading', { name, exact: true, level: 2 }) });
  assert.equal(await panel.count(), 1, `${name} is shown as a plain section`);
  assert.equal(await panel.isVisible(), true);
  return panel;
}
async function noOverflow(page) {
  const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, tuning: document.querySelector('.tuning-page').getBoundingClientRect().width }));
  assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1 && widths.tuning <= widths.viewport + 1, JSON.stringify(widths));
}
async function run(name, language, action, { job = '', calibration = '', extra = '', viewport = { width: 1366, height: 768 }, configWrites = false } = {}) {
  if (selectedCase && selectedCase !== name) return;
  const context = await browser.newContext({ viewport, acceptDownloads: true }), blocked = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/tuning-compact-app.html?language=${language}${job ? `&job=${job}` : ''}${calibration ? `&calibration=${calibration}` : ''}${extra}#tuning`);
    await area(page).getByRole('heading', { name: labels(language).title, exact: true }).waitFor();
    if (calibration) await area(page).locator('[data-testid="tuning-calibration"]').waitFor();
    else if (job) await page.waitForFunction(() => !!document.querySelector('.tuning-live, [data-testid="calibration-start"]'));
    else await page.waitForFunction(() => !document.querySelector('[data-testid="calibration-start"]')?.disabled);
    await action(page, labels(language));
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, [], 'No requests attempted outside the isolated fixture origin');
    const forbidden = await page.evaluate(writes => window.__fixture.calls.filter(call => new RegExp(`^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|update_runtime_zip|prepare_local_runtime|strata_stream${writes ? '' : '|write_config|copy_configuration'})$`).test(call.command)), configWrites);
    assert.deepEqual(forbidden, [], 'No model lifecycle, GPU generation, installation or unrequested configuration writes');
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
        await fullMode(page, language);
        await advanced(page).getByRole('switch', { name: text.worker, exact: true }).waitFor();
        await page.screenshot({ path: resolve(output, `first-screen-${language}-${viewport.width}-plan.png`), fullPage: false });
      }, { viewport });
    }
    await run(`quick-start-${language}`, language, async (page, text) => {
      await firstScreen(page, language);
      await choose(page, text.quickRounds, language === 'en' ? '4 rounds' : '4 轮');
      await area(page).getByRole('button', { name: text.startQuick, exact: true }).click();
      await area(page).getByRole('button', { name: text.cancelQuick, exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.calibration.starts), [{ profileId: 'a', request: { rounds: 4 } }]);
      assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'tuning_start').length), 0);
      await area(page).locator('[data-testid="tuning-live-rate"]').getByText('35.4', { exact: true }).waitFor();
    });
    await run(`quick-running-live-${language}`, language, async (page, text) => {
      const live = area(page).locator('[data-testid="tuning-live"]');
      await insideFirstScreen(live.locator('[data-testid="tuning-live-rate"]'), page, 'live tok/s');
      assert.match(await live.innerText(), /35\.4/);
      assert.equal(await live.getByRole('progressbar').getAttribute('aria-valuenow'), String(await page.evaluate(() => window.__fixture.calibration.job.completedRequests)));
      assert.equal(await live.getByRole('progressbar').getAttribute('aria-valuemax'), '105');
      assert.ok((await area(page).locator('[data-testid="tuning-log"] li').count()) > 10, 'Each sample appears in the log while running');
      const chart = area(page).locator('[data-testid="sweep-pcieFrac"]');
      assert.equal(await chart.locator('circle').count() >= 6, true);
      assert.equal(await area(page).getByText(text.amdZero, { exact: false }).isVisible(), true, 'pcie_frac 0 is never measured on AMD');
      assert.equal(await area(page).locator('[data-testid="calibration-save-version"]').count(), 0);
      await noFolding(page);
      await page.screenshot({ path: resolve(output, `quick-running-live-${language}-first-screen.png`), fullPage: false });
      await area(page).getByRole('button', { name: text.cancelQuick, exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calibration.cancels.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__fixture.calibration.cancels), [{ jobId: 'isolated-calibration-job' }]);
    }, { calibration: 'running' });
    await run(`quick-finished-save-version-${language}`, language, async (page, text) => {
      const result = area(page).locator('[data-testid="tuning-calibration-result"]');
      assert.match(await result.innerText(), /\+8\.6%/);
      assert.match(await area(page).locator('[data-testid="tuning-diff"]').innerText(), /0\.55[\s\S]*0\.35/);
      await insideFirstScreen(result.getByRole('button', { name: text.saveVersion, exact: true }), page, text.saveVersion);
      assert.equal(await result.getByRole('button', { name: text.benchmark, exact: true }).isVisible(), true, 'Leaderboard path is an explicit, separate action');
      await result.getByRole('button', { name: text.saveVersion, exact: true }).click();
      await result.getByText(text.saved, { exact: false }).waitFor();
      const copies = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'copy_configuration').map(call => call.args));
      assert.equal(copies.length, 1);
      assert.match(copies[0].filename, /^a-calibrated-\d{8}-\d{4}\.json$/);
      assert.deepEqual(copies[0].config.args, ['--model', 'fixture/a.gguf', '--pool-workers', '4', '--pcie-frac', '0.35', '--spec-min-p', '0.50']);
      assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'write_config' || /arena/.test(call.command)).length), 0, 'Default keeps the current config and uploads nothing');
      await noFolding(page);
    }, { calibration: 'finished', configWrites: true });
    await run(`quick-finished-verify-scenarios-${language}`, language, async (page, text) => {
      await area(page).getByRole('button', { name: text.verify, exact: true }).click();
      assert.equal(await area(page).getByRole('radio', { name: text.full, exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await area(page).locator('[data-testid="tuning-suggested"] li').count(), 4);
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await page.waitForFunction(() => window.__fixture.tuning.starts.length === 1);
      assert.deepEqual((await page.evaluate(() => window.__fixture.tuning.starts))[0].request.restartCandidates, [{ poolWorkers: 13 }, { poolWorkers: 10 }, { adaptEvery: 1, adaptSwaps: 80, adaptDecay: 0.97 }, { adaptEvery: 1, adaptSwaps: 160, adaptDecay: 0.97 }]);
      await area(page).locator('[data-testid="tuning-live"]').waitFor();
    }, { calibration: 'finished' });
    await run(`full-start-parameters-${language}`, language, async (page, text) => {
      await firstScreen(page, language); await fullMode(page, language);
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await area(page).getByRole('button', { name: text.cancel, exact: true }).waitFor();
      const starts = await page.evaluate(() => window.__fixture.tuning.starts);
      assert.deepEqual(starts, [{ profileId: 'a', request: { useCase: 'chat', contextLimit: 8192, includeVision: false, rounds: 2, maxTokens: 1024 } }]);
      assert.match(await area(page).locator('.tuning-live').innerText(), /3 \/ 12/);
      assert.match(await area(page).locator('[data-testid="tuning-live-rate"]').innerText(), /33\.2/);
      await insideFirstScreen(area(page).getByRole('button', { name: text.cancel, exact: true }), page, text.cancel);
    });
    await run(`diagnostic-parameters-${language}`, language, async (page, text) => {
      await area(page).getByRole('radio', { name: text.diagnostic, exact: true }).click();
      assert.equal(await area(page).getByRole('combobox', { name: text.purpose, exact: true }).count(), 0);
      await choose(page, text.rounds, '3'); await choose(page, text.tokens, '256');
      await advanced(page).getByRole('switch', { name: text.chinese, exact: true }).click();
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await page.waitForFunction(() => window.__fixture.tuning.starts.length === 1);
      const [start] = await page.evaluate(() => window.__fixture.tuning.starts);
      assert.deepEqual(start, { profileId: 'a', request: { scenes: ['chat', 'code'], rounds: 3, maxTokens: 256 } });
    });
    await run(`running-cancel-recovery-${language}`, language, async (page, text) => {
      assert.equal(await area(page).getByRole('radio', { name: text.full, exact: true }).getAttribute('aria-checked'), 'true', 'A running scenario job opens in its own mode');
      const live = area(page).locator('.tuning-live');
      assert.match(await live.innerText(), new RegExp(text.running));
      assert.equal(await live.getByRole('progressbar').getAttribute('aria-valuenow'), '3');
      assert.match(await area(page).locator('.tuning-recovery').innerText(), new RegExp(text.pending));
      await noFolding(page);
      await insideFirstScreen(area(page).getByRole('button', { name: text.cancel, exact: true }), page, text.cancel);
      await page.screenshot({ path: resolve(output, `running-cancel-recovery-${language}-running.png`), fullPage: false });
      await area(page).getByRole('button', { name: text.cancel, exact: true }).click();
      await area(page).locator('.tuning-progress').getByText(text.canceled, { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.cancels), [{ jobId: 'isolated-tuning-job' }]);
      assert.equal(await area(page).locator('.tuning-recovery').isVisible(), true);
    }, { job: 'running', viewport: { width: 1366, height: 900 } });
    await run(`failed-quality-and-recovery-${language}`, language, async (page, text) => {
      await area(page).getByRole('radio', { name: text.full, exact: true }).click();
      const detail = await page.evaluate(() => window.__fixture.tuning.detail), recoveryError = await page.evaluate(() => window.__fixture.tuning.recoveryError);
      assert.match(await area(page).locator('.tuning-errors').innerText(), new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(await area(page).locator('.tuning-recovery').innerText(), new RegExp(text.failure));
      assert.equal(await area(page).locator('.tuning-recovery').getByText(recoveryError, { exact: true }).isVisible(), true);
      assert.equal(await area(page).getByRole('button', { name: text.start, exact: true }).isDisabled(), true);
      const details = await section(page, text.workloadDetails);
      assert.equal(await details.getByText(detail, { exact: true }).isVisible(), true);
      await noFolding(page);
    }, { job: 'failed' });
    await run(`recommendation-apply-restore-${language}`, language, async (page, text) => {
      await area(page).getByRole('radio', { name: text.full, exact: true }).click();
      const apply = area(page).getByRole('button', { name: text.apply, exact: true });
      assert.equal(await apply.isEnabled(), true);
      await apply.click();
      const restore = area(page).getByRole('button', { name: text.restore, exact: true }); await restore.waitFor();
      assert.equal(await restore.isEnabled(), true);
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.applies), [{ jobId: 'isolated-tuning-job', candidateId: 'candidate-1' }]);
      await restore.click();
      await page.waitForFunction(() => window.__fixture.tuning.restores.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.restores), [{ jobId: 'isolated-tuning-job' }]);
      const sceneResults = await section(page, text.sceneResults);
      assert.equal(await sceneResults.locator('[data-testid="tuning-fullAgent"]').isVisible(), true);
      assert.match(await sceneResults.locator('[data-testid="tuning-vision"]').innerText(), new RegExp(text.noVision));
      const candidates = await section(page, text.comparisons);
      assert.equal(await candidates.locator('tbody tr').count(), 1);
      await section(page, text.workloadDetails);
      assert.equal(await area(page).getByRole('button', { name: language === 'en' ? 'Export report' : '导出报告', exact: true }).isVisible(), true);
      await noFolding(page);
    }, { job: 'recommended' });
    await run(`narrow-layout-${language}`, language, async (page, text) => {
      await noOverflow(page);
      await insideFirstScreen(area(page).getByRole('button', { name: text.saveVersion, exact: true }), page, text.saveVersion);
      await area(page).getByRole('radio', { name: text.full, exact: true }).click();
      await noOverflow(page);
      for (const name of [text.sceneResults, text.comparisons, text.workloadDetails]) await section(page, name);
      await noOverflow(page);
      const wraps = await area(page).locator('.table-wrap').evaluateAll(elements => elements.map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })));
      assert.ok(wraps.some(wrap => wrap.scroll > wrap.width), 'Wide tables scroll inside their containers');
    }, { job: 'recommended', calibration: 'finished', viewport: { width: 480, height: 1000 } });
  }
  await run('quick-finished-overwrite', 'zh-CN', async (page, text) => {
    await area(page).getByRole('button', { name: text.overwrite, exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.match(await dialog.innerText(), /\.bak/);
    await dialog.getByRole('button', { name: text.confirmOverwrite, exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'write_config'));
    const [write] = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'write_config').map(call => call.args));
    assert.deepEqual(write.config.args.slice(-4), ['--pcie-frac', '0.35', '--spec-min-p', '0.50']);
    assert.ok(write.expectedRevision, 'Overwrite uses the revision read just before writing');
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'copy_configuration').length), 0);
  }, { calibration: 'finished', configWrites: true });
  await run('quick-config-drift-confirm', 'zh-CN', async (page, text) => {
    const copies = () => page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'copy_configuration').map(call => call.args));
    const save = area(page).getByRole('button', { name: text.saveVersion, exact: true });
    await save.click();
    let dialog = page.getByRole('dialog', { name: '配置在校准后已被修改', exact: true }); await dialog.waitFor();
    assert.match(await dialog.innerText(), /推荐值是在旧配置上测得的/);
    assert.equal((await copies()).length, 0, 'Nothing is written before the change is confirmed');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal((await copies()).length, 0, 'Cancel writes nothing');
    await save.click();
    dialog = page.getByRole('dialog', { name: '配置在校准后已被修改', exact: true }); await dialog.waitFor();
    await dialog.getByRole('button', { name: '仍然应用', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'copy_configuration'));
    assert.deepEqual((await copies())[0].config.args, ['--model', 'fixture/a.gguf', '--pool-workers', '4', '--stats', '--pcie-frac', '0.35', '--spec-min-p', '0.50'], 'Applies onto the edited config, keeping the edit');
    // Overwrite asks again: confirm overwrite, then confirm the changed config.
    await area(page).getByRole('button', { name: text.overwrite, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: text.confirmOverwrite, exact: true }).click();
    dialog = page.getByRole('dialog', { name: '配置在校准后已被修改', exact: true }); await dialog.waitFor();
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'write_config').length), 0);
    await dialog.getByRole('button', { name: '仍然应用', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'write_config'));
  }, { calibration: 'finished', extra: '&configEdited=1', configWrites: true });
  await run('quick-persisted-log', 'en', async page => {
    const log = area(page).locator('[data-testid="tuning-log"]');
    await area(page).getByTestId('tuning-log-saved').waitFor();
    assert.match(await area(page).getByTestId('tuning-log-saved').innerText(), /never prompts or answers/);
    assert.equal(await log.locator('li').count(), 4, 'The ended job shows the log stored in its report');
    assert.match(await log.innerText(), /PCIe[\s\S]*0\.35/);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'tuning_live').length), 0, 'No live polling once the job ended');
  }, { calibration: 'finished' });
  await run('quick-no-change', 'zh-CN', async (page, text) => {
    await area(page).getByText(text.noChange, { exact: true }).waitFor();
    assert.equal(await area(page).getByRole('button', { name: text.saveVersion, exact: true }).count(), 0);
    assert.equal(await area(page).getByRole('button', { name: text.overwrite, exact: true }).count(), 0);
    assert.equal(await area(page).getByRole('button', { name: text.verify, exact: true }).isVisible(), true);
  }, { calibration: 'nochange' });
  await run('advanced-candidates-and-bounds', 'zh-CN', async (page, text) => {
    await fullMode(page, 'zh-CN');
    await choose(page, text.purpose, text.agent); await choose(page, text.rounds, '4'); await choose(page, text.context, '32,768');
    await advanced(page).getByRole('switch', { name: text.worker, exact: true }).click();
    await area(page).getByRole('button', { name: text.start, exact: true }).click();
    await page.waitForFunction(() => window.__fixture.tuning.starts.length === 1);
    assert.deepEqual((await page.evaluate(() => window.__fixture.tuning.starts))[0].request, { useCase: 'agent', contextLimit: 32768, includeVision: false, rounds: 4, maxTokens: 1024, restartCandidates: [{ poolWorkers: 8 }] });
    await area(page).getByRole('button', { name: text.cancel, exact: true }).click();
    await area(page).locator('.tuning-progress').getByText(text.canceled, { exact: true }).waitFor();
    for (const name of ['比较异步换入', '比较预填充分块', '比较显存预留', '重排间隔']) await advanced(page).getByRole('switch', { name, exact: true }).click();
    assert.equal(await area(page).getByRole('alert').filter({ hasText: '最多选择四个重启候选' }).isVisible(), true);
    assert.equal(await area(page).getByRole('button', { name: text.start, exact: true }).isDisabled(), true);
  });
  await run('legacy-report-cannot-apply', 'zh-CN', async (page, text) => {
    await area(page).getByRole('radio', { name: text.full, exact: true }).click();
    assert.equal(await area(page).getByText('历史短请求报告', { exact: true }).isVisible(), true);
    assert.equal(await area(page).getByRole('button', { name: text.apply, exact: true }).count(), 0);
    await section(page, text.comparisons);
  }, { job: 'legacy' });
} finally { await browser?.close(); await server.close(); }
await writeFile(resolve(output, selectedCase ? `browser-results-${selectedCase.replace(/[^a-z0-9-]/gi, '')}.json` : 'browser-results.json'), JSON.stringify({ scope: 'Real React App with in-memory tuning jobs, random fixture port and blocked external HTTP. No native supervisor, GPU, model or installed application acceptance.', fixturePort: address.port, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
