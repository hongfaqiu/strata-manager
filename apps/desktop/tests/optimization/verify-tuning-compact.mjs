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
  title: 'One-click speed-up', advanced: 'Advanced · expert mode', useCase: 'Main use', goal: 'Goal', quickRounds: 'Rounds per value',
  agentUse: 'Coding and agents', speedGoal: 'Fastest', fourRounds: '4 rounds',
  purpose: 'How do you mainly use the model?', full: 'Scenario verification', diagnostic: 'Short diagnostics',
  rounds: 'Repeated rounds', context: 'Context limit for this test', start: 'Start measurement', cancel: 'Cancel test',
  saveVersion: 'Save as new config version', overwrite: 'Overwrite current config', confirmOverwrite: 'Overwrite and save',
  verify: 'Verify with scenarios', benchmark: 'Run Benchmark', saved: 'New config version saved', noChange: 'The current values are already the fastest. Nothing to change.', amdZero: 'Skipped 0 on AMD',
  running: 'Measuring', canceled: 'Canceled', recovery: 'Configuration and service recovery',
  pending: 'Recovery record saved', failure: 'Recovery failed; repair required', apply: 'Apply and verify', restore: 'Restore original parameters',
  worker: 'Compare CPU worker count', agent: 'Coding and Agent', noVision: 'Not tested',
  sceneResults: 'Scenario results', comparisons: 'Candidate comparison', workloadDetails: 'Complete workload details',
  same: 'Your current settings are already the fastest', belowMin: 'The best alternative was not clearly faster (under 3%), so the current settings stay.',
} : {
  title: '一键提速', advanced: '高级 · 专家模式', useCase: '主要用途', goal: '目标', quickRounds: '每个值测几轮',
  agentUse: '编程与 Agent', speedGoal: '速度优先', fourRounds: '4 轮',
  purpose: '你主要怎样使用模型？', full: '场景验收', diagnostic: '短请求诊断',
  rounds: '重复轮数', context: '本次上下文上限', start: '开始实测', cancel: '取消测试',
  saveVersion: '另存为新配置版本', overwrite: '覆盖当前配置', confirmOverwrite: '覆盖并保存',
  verify: '用场景验收复核', benchmark: '运行 Benchmark', saved: '已保存新配置版本', noChange: '当前参数已经是最快的，无需修改。', amdZero: 'AMD 显卡跳过 0',
  running: '测量中', canceled: '已取消', recovery: '配置与服务恢复',
  pending: '已保存恢复记录', failure: '恢复失败，需要修复', apply: '应用并验证', restore: '恢复原参数',
  worker: '比较 CPU 工作线程', agent: '编程与 Agent', noVision: '未测试',
  sceneResults: '场景结果', comparisons: '候选比较', workloadDetails: '完整任务明细',
  same: '当前设置已经是最快的', belowMin: '找到的设置快得不够明显（不到 3%），所以保留当前设置。',
};
async function insideFirstScreen(locator, page, name) {
  assert.equal(await locator.isVisible(), true, `${name} is visible`);
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert.ok(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height && box.x >= 0 && box.x + box.width <= viewport.width, `${name} fits first screen: ${JSON.stringify({ box, viewport })}`);
}
// #38 lifted for one-click tuning: the expert area is the single collapsed region.
const expert = page => area(page).locator('details.tuning-expert');
async function oneFold(page, open = false) {
  assert.equal(await area(page).locator('details').count(), 1, 'Exactly one <details> on the tuning page');
  assert.equal(await expert(page).count(), 1);
  assert.equal(await expert(page).evaluate(element => element.open), open, `Expert area is ${open ? 'open' : 'collapsed'}`);
}
async function openAdvanced(page) {
  if (!await expert(page).evaluate(element => element.open)) await expert(page).locator('summary').click();
  await expert(page).locator('[data-testid="speed-boost-options"]').waitFor();
}
const hero = page => area(page).locator('[data-testid="speed-boost"]');
const calls = (page, command) => page.evaluate(command => window.__fixture.calls.filter(call => call.command === command).map(call => call.args), command);
async function firstScreen(page, language) {
  const text = labels(language);
  await insideFirstScreen(hero(page).getByTestId('speed-boost-start'), page, 'one-click start');
  assert.equal(await hero(page).getByTestId('speed-boost-start').isEnabled(), true);
  assert.equal(await expert(page).locator('summary').isVisible(), true);
  assert.match(await expert(page).locator('summary').innerText(), new RegExp(text.advanced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await oneFold(page, false);
  // Beginner surface: no required choices and no engine jargon while the expert area is closed.
  assert.equal(await area(page).getByRole('radiogroup', { name: text.useCase }).isVisible(), false, 'Use case is not asked up front');
  const visible = await area(page).evaluate(element => element.innerText);
  for (const word of ['PCIe', 'MTP', 'pcie', '漂移', 'drift', text.diagnostic]) assert.equal(visible.includes(word), false, `No "${word}" on the first screen`);
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
async function run(name, language, action, { job = '', calibration = '', extra = '', viewport = { width: 1366, height: 768 }, configWrites = false, switches = false } = {}) {
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
    if (['zh-CN', 'en'].includes(language)) await area(page).getByRole('heading', { name: labels(language).title, exact: true }).waitFor();
    else await area(page).locator('h2').first().waitFor();
    await area(page).locator('[data-testid="speed-health"] li').first().waitFor();
    if (calibration) await page.waitForFunction(() => !!document.querySelector('[data-testid="speed-boost-running"], [data-testid="speed-boost-result"], [data-testid="speed-boost-same"]'));
    else if (job) await page.waitForFunction(() => !!document.querySelector('.tuning-live, .tuning-progress'));
    else await page.waitForFunction(() => document.querySelector('[data-testid="speed-boost-start"]') && !document.querySelector('[data-testid="speed-boost-start"]').disabled);
    await action(page, labels(language));
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, [], 'No requests attempted outside the isolated fixture origin');
    const forbidden = await page.evaluate(([writes, switching]) => window.__fixture.calls.filter(call => new RegExp(`^(ensure_local_service|start_service|stop_service|restart_service|take_over_service|update_runtime_zip|prepare_local_runtime|strata_stream${writes ? '' : '|write_config|copy_configuration'}${switching ? '' : '|switch_local_service'})$`).test(call.command)), [configWrites, switches]);
    assert.deepEqual(forbidden, [], 'No model lifecycle, GPU generation, installation or unrequested configuration writes');
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), pageErrors: errors, blocked }); console.log(`FAIL ${name}: ${error}`);
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    await writeFile(resolve(output, `${name}-failure.txt`), await page.locator('body').innerText());
  } finally { await context.close(); }
}
async function fullMode(page, language) {
  const text = labels(language);
  await openAdvanced(page);
  for (const name of [text.purpose, text.rounds, text.context]) assert.equal(await area(page).getByRole('combobox', { name, exact: true }).isVisible(), true, `${name} in the expert area`);
  await area(page).getByRole('button', { name: text.start, exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await area(page).getByRole('button', { name: text.start, exact: true }).isVisible(), true);
}
const sorted = value => JSON.parse(JSON.stringify(value, Object.keys(value).sort()));
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  for (const language of ['zh-CN', 'en']) {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1800, height: 1200 }]) {
      await run(`first-screen-${language}-${viewport.width}`, language, async page => {
        await firstScreen(page, language);
        assert.equal(await area(page).locator('[data-testid="speed-check-vramHeadroom"].is-ok').count(), 1, 'Healthy fixture passes the VRAM check');
        assert.equal(await area(page).getByRole('radio', { name: labels(language).diagnostic }).count() + await area(page).getByRole('button', { name: labels(language).diagnostic }).count(), 0, 'Short diagnostics are no longer offered');
        await fullMode(page, language);
        await oneFold(page, true);
        await advanced(page).getByRole('switch', { name: labels(language).worker, exact: true }).waitFor();
        await page.screenshot({ path: resolve(output, `first-screen-${language}-${viewport.width}-advanced.png`), fullPage: false });
      }, { viewport });
    }
    await run(`one-click-start-${language}`, language, async page => {
      await firstScreen(page, language);
      await hero(page).getByTestId('speed-boost-start').click();
      await hero(page).getByTestId('speed-boost-running').waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.calibration.starts), [{ profileId: 'a', request: { rounds: 2, workload: 'general', goal: 'balanced' } }]);
      assert.equal((await calls(page, 'tuning_start')).length, 0);
      await hero(page).getByText('35.4', { exact: true }).waitFor();
      await oneFold(page, false);
    });
    await run(`advanced-options-${language}`, language, async page => {
      const text = labels(language);
      await openAdvanced(page);
      await area(page).getByRole('radiogroup', { name: text.useCase }).getByRole('radio', { name: text.agentUse, exact: true }).click();
      await area(page).getByRole('radiogroup', { name: text.goal }).getByRole('radio', { name: text.speedGoal, exact: true }).click();
      await choose(page, text.quickRounds, text.fourRounds);
      await hero(page).getByTestId('speed-boost-start').click();
      await hero(page).getByTestId('speed-boost-running').waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.calibration.starts), [{ profileId: 'a', request: { rounds: 4, workload: 'agent', goal: 'speed' } }]);
    });
    await run(`running-cancel-${language}`, language, async page => {
      const running = hero(page).getByTestId('speed-boost-running');
      await insideFirstScreen(running.getByRole('progressbar'), page, 'progress');
      assert.match(await running.innerText(), /35\.4/);
      await insideFirstScreen(running.getByTestId('speed-boost-cancel'), page, 'cancel');
      await oneFold(page, false);
      // Detailed sweep stays available in the expert area.
      await openAdvanced(page);
      const chart = area(page).locator('[data-testid="sweep-pcieFrac"]');
      assert.equal(await chart.locator('circle').count() >= 6, true);
      assert.equal(await area(page).getByText(labels(language).amdZero, { exact: false }).isVisible(), true, 'pcie_frac 0 is never measured on AMD');
      assert.ok((await area(page).locator('[data-testid="tuning-log"] li').count()) > 10);
      await running.getByTestId('speed-boost-cancel').click();
      await page.waitForFunction(() => window.__fixture.calibration.cancels.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__fixture.calibration.cancels), [{ jobId: 'isolated-calibration-job' }]);
    }, { calibration: 'running' });
    await run(`result-apply-rollback-${language}`, language, async page => {
      const result = hero(page).getByTestId('speed-boost-result');
      await insideFirstScreen(result.getByTestId('speed-boost-apply'), page, 'apply');
      assert.match(await result.getByTestId('speed-boost-gain').innerText(), /8\.6/);
      assert.match(await result.innerText(), /36\.2[\s\S]*39\.3/);
      assert.match(await result.innerText(), /38\.4[\s\S]*41\.6[\s\S]*34\.1[\s\S]*37\.1/, 'Short and long answers are both shown');
      assert.match(await result.getByTestId('speed-boost-changes').innerText(), /--pcie-frac 0\.35/);
      assert.doesNotMatch(await result.getByTestId('speed-boost-changes').innerText(), /spec-min-p/, 'Only measured changes are listed');
      await result.getByTestId('speed-boost-apply').click();
      await hero(page).getByTestId('speed-boost-applied').waitFor();
      const copies = await calls(page, 'copy_configuration');
      assert.equal(copies.length, 1);
      assert.match(copies[0].filename, /^a-speedup-\d{8}-\d{4}\.json$/);
      assert.deepEqual(copies[0].config.args, ['--model', 'fixture/a.gguf', '--pool-workers', '4', '--pcie-frac', '0.35']);
      assert.equal((await calls(page, 'write_config')).length, 0, 'The original file is never written');
      const switches = await page.evaluate(() => window.__fixture.calibration.switches);
      assert.equal(switches.length, 1);
      assert.match(switches[0], /^copy-/, 'Switches to the new copy');
      await hero(page).getByTestId('speed-boost-rollback').click();
      await page.waitForFunction(() => window.__fixture.calibration.switches.length === 2);
      assert.equal((await page.evaluate(() => window.__fixture.calibration.switches))[1], 'a');
      await hero(page).getByTestId('speed-boost-idle').waitFor();
      assert.equal(await hero(page).getByTestId('speed-boost-apply').count(), 0, 'A rolled-back result is not offered again');
      assert.match(await hero(page).innerText(), language === 'en' ? /Switched back/ : /已切回原配置/);
    }, { calibration: 'finished', extra: '&switch=1', configWrites: true, switches: true });
    await run(`expert-save-version-${language}`, language, async page => {
      const text = labels(language);
      await openAdvanced(page);
      const view = area(page).locator('[data-testid="tuning-calibration-result"]');
      assert.match(await area(page).locator('[data-testid="tuning-diff"]').innerText(), /0\.55[\s\S]*0\.35/);
      assert.equal(await view.getByRole('button', { name: text.benchmark, exact: true }).isVisible(), true);
      await view.getByRole('button', { name: text.saveVersion, exact: true }).click();
      await view.getByText(text.saved, { exact: false }).waitFor();
      const copies = await calls(page, 'copy_configuration');
      assert.equal(copies.length, 1);
      assert.match(copies[0].filename, /^a-calibrated-\d{8}-\d{4}\.json$/);
      assert.deepEqual(copies[0].config.args, ['--model', 'fixture/a.gguf', '--pool-workers', '4', '--pcie-frac', '0.35']);
      assert.equal((await calls(page, 'write_config')).length, 0);
    }, { calibration: 'finished', configWrites: true });
    await run(`expert-verify-scenarios-${language}`, language, async page => {
      const text = labels(language);
      await openAdvanced(page);
      await area(page).getByRole('button', { name: text.verify, exact: true }).click();
      assert.equal(await area(page).locator('[data-testid="tuning-suggested"] li').count(), 4);
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await page.waitForFunction(() => window.__fixture.tuning.starts.length === 1);
      assert.deepEqual((await page.evaluate(() => window.__fixture.tuning.starts))[0].request.restartCandidates, [{ poolWorkers: 13 }, { poolWorkers: 10 }, { adaptEvery: 1, adaptSwaps: 80, adaptDecay: 0.97 }, { adaptEvery: 1, adaptSwaps: 160, adaptDecay: 0.97 }]);
      await area(page).locator('[data-testid="tuning-live"]').waitFor();
    }, { calibration: 'finished' });
    await run(`full-start-parameters-${language}`, language, async page => {
      const text = labels(language);
      await fullMode(page, language);
      await area(page).getByRole('button', { name: text.start, exact: true }).click();
      await area(page).getByRole('button', { name: text.cancel, exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.starts), [{ profileId: 'a', request: { useCase: 'chat', contextLimit: 8192, includeVision: false, rounds: 2, maxTokens: 1024 } }]);
      assert.match(await area(page).locator('.tuning-live').innerText(), /3 \/ 12/);
      assert.match(await area(page).locator('[data-testid="tuning-live-rate"]').innerText(), /33\.2/);
    });
    await run(`running-full-opens-expert-${language}`, language, async page => {
      const text = labels(language);
      await oneFold(page, true);
      const live = area(page).locator('.tuning-live');
      assert.match(await live.innerText(), new RegExp(text.running));
      assert.equal(await live.getByRole('progressbar').getAttribute('aria-valuenow'), '3');
      assert.match(await area(page).locator('.tuning-recovery').innerText(), new RegExp(text.pending));
      assert.equal(await hero(page).getByTestId('speed-boost-start').isDisabled(), true, 'One-click waits for the running verification');
      await area(page).getByRole('button', { name: text.cancel, exact: true }).click();
      await area(page).locator('.tuning-progress').getByText(text.canceled, { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.cancels), [{ jobId: 'isolated-tuning-job' }]);
    }, { job: 'running', viewport: { width: 1366, height: 900 } });
    await run(`failed-quality-and-recovery-${language}`, language, async page => {
      const text = labels(language);
      await openAdvanced(page);
      const detail = await page.evaluate(() => window.__fixture.tuning.detail), recoveryError = await page.evaluate(() => window.__fixture.tuning.recoveryError);
      assert.match(await area(page).locator('.tuning-errors').innerText(), new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(await area(page).locator('.tuning-recovery').innerText(), new RegExp(text.failure));
      assert.equal(await area(page).locator('.tuning-recovery').getByText(recoveryError, { exact: true }).isVisible(), true);
      assert.equal(await area(page).getByRole('button', { name: text.start, exact: true }).isDisabled(), true);
      assert.equal(await hero(page).getByTestId('speed-boost-start').isDisabled(), true);
      const details = await section(page, text.workloadDetails);
      assert.equal(await details.getByText(detail, { exact: true }).isVisible(), true);
    }, { job: 'failed' });
    await run(`recommendation-apply-restore-${language}`, language, async page => {
      const text = labels(language);
      await openAdvanced(page);
      const apply = area(page).getByRole('button', { name: text.apply, exact: true });
      assert.equal(await apply.isEnabled(), true);
      await apply.click();
      const restore = area(page).getByRole('button', { name: text.restore, exact: true }); await restore.waitFor();
      assert.deepEqual(await page.evaluate(() => window.__fixture.tuning.applies), [{ jobId: 'isolated-tuning-job', candidateId: 'candidate-1' }]);
      await restore.click();
      await page.waitForFunction(() => window.__fixture.tuning.restores.length === 1);
      const sceneResults = await section(page, text.sceneResults);
      assert.equal(await sceneResults.locator('[data-testid="tuning-fullAgent"]').isVisible(), true);
      assert.match(await sceneResults.locator('[data-testid="tuning-vision"]').innerText(), new RegExp(text.noVision));
      assert.equal(await (await section(page, text.comparisons)).locator('tbody tr').count(), 1);
      await section(page, text.workloadDetails);
    }, { job: 'recommended' });
    await run(`narrow-layout-${language}`, language, async page => {
      const text = labels(language);
      await noOverflow(page);
      await insideFirstScreen(hero(page).getByTestId('speed-boost-apply'), page, 'apply');
      await openAdvanced(page);
      await noOverflow(page);
      for (const name of [text.sceneResults, text.comparisons, text.workloadDetails]) await section(page, name);
      await noOverflow(page);
      const wraps = await area(page).locator('.table-wrap').evaluateAll(elements => elements.map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })));
      assert.ok(wraps.some(wrap => wrap.scroll > wrap.width), 'Wide tables scroll inside their containers');
    }, { job: 'recommended', calibration: 'finished', viewport: { width: 480, height: 1000 } });
    await run(`health-fix-all-${language}`, language, async page => {
      assert.equal(await area(page).locator('[data-testid="speed-check-vramHeadroom"].is-fix').count(), 1);
      assert.equal(await area(page).locator('[data-testid="speed-check-kvInRam"].is-fix').count(), 1);
      assert.match(await area(page).getByTestId('speed-check-kvInRam').innerText(), /128K/);
      await insideFirstScreen(area(page).getByTestId('speed-fix-all'), page, 'fix all');
      await area(page).getByTestId('speed-fix-all').click();
      await page.waitForFunction(() => window.__fixture.calibration.switches.length === 1);
      const [copy] = await calls(page, 'copy_configuration');
      assert.match(copy.filename, /^a-speedfix-\d{8}-\d{4}\.json$/);
      const args = copy.config.args, value = flag => args[args.indexOf(flag) + 1];
      // Linux floor 512 MiB + 256 margin, rounded up to 256 (the Windows floor would give 1280).
      assert.equal(value('--vram-reserve-mib'), '768');
      assert.equal(value('--expert-cache'), 'auto');
      assert.equal(value('--kv-resident'), '32768');
      assert.equal(args.filter(arg => arg === '--expert-cache').length, 1, 'The fixed expert cache is replaced, not duplicated');
      assert.equal((await calls(page, 'write_config')).length, 0);
      await hero(page).getByTestId('speed-boost-applied').waitFor();
    }, { extra: '&health=low&switch=1', configWrites: true, switches: true });
  }
  await run('expert-overwrite', 'zh-CN', async (page, text) => {
    await openAdvanced(page);
    await area(page).getByRole('button', { name: text.overwrite, exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.match(await dialog.innerText(), /\.bak/);
    await dialog.getByRole('button', { name: text.confirmOverwrite, exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'write_config'));
    const [write] = await calls(page, 'write_config');
    assert.deepEqual(write.config.args.slice(-2), ['--pcie-frac', '0.35']);
    assert.ok(write.expectedRevision, 'Overwrite uses the revision read just before writing');
    assert.equal((await calls(page, 'copy_configuration')).length, 0);
  }, { calibration: 'finished', configWrites: true });
  await run('config-drift-confirm', 'zh-CN', async page => {
    const copies = () => calls(page, 'copy_configuration');
    const apply = hero(page).getByTestId('speed-boost-apply');
    await apply.click();
    let dialog = page.getByRole('dialog', { name: '配置在校准后已被修改', exact: true }); await dialog.waitFor();
    assert.match(await dialog.innerText(), /推荐值是在旧配置上测得的/);
    assert.equal((await copies()).length, 0, 'Nothing is written before the change is confirmed');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal((await copies()).length, 0, 'Cancel writes nothing');
    await apply.click();
    dialog = page.getByRole('dialog', { name: '配置在校准后已被修改', exact: true }); await dialog.waitFor();
    await dialog.getByRole('button', { name: '仍然应用', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'copy_configuration'));
    assert.deepEqual((await copies())[0].config.args, ['--model', 'fixture/a.gguf', '--pool-workers', '4', '--stats', '--pcie-frac', '0.35'], 'Applies onto the edited config, keeping the edit');
  }, { calibration: 'finished', extra: '&configEdited=1&switch=1', configWrites: true, switches: true });
  await run('auto-preferred-removes-flag', 'zh-CN', async page => {
    const result = hero(page).getByTestId('speed-boost-result');
    assert.match(await result.getByTestId('speed-boost-changes').innerText(), /让引擎自己安排[\s\S]*--pcie-frac → auto/);
    await result.getByTestId('speed-boost-apply').click();
    await page.waitForFunction(() => window.__fixture.calibration.switches.length === 1);
    const [copy] = await calls(page, 'copy_configuration');
    assert.equal(copy.config.args.includes('--pcie-frac'), false, 'Going back to the engine share drops the fixed flag');
  }, { calibration: 'autoback', extra: '&switch=1', configWrites: true, switches: true });
  await run('persisted-log', 'en', async page => {
    await openAdvanced(page);
    const log = area(page).locator('[data-testid="tuning-log"]');
    await area(page).getByTestId('tuning-log-saved').waitFor();
    assert.match(await area(page).getByTestId('tuning-log-saved').innerText(), /never prompts or answers/);
    assert.equal(await log.locator('li').count(), 4, 'The ended job shows the log stored in its report');
    assert.match(await log.innerText(), /PCIe[\s\S]*0\.35/);
    assert.equal((await calls(page, 'tuning_live')).length, 0, 'No live polling once the job ended');
  }, { calibration: 'finished' });
  await run('no-change', 'zh-CN', async (page, text) => {
    const same = hero(page).getByTestId('speed-boost-same');
    await same.getByText(text.same, { exact: true }).waitFor();
    assert.equal(await same.getByText(text.belowMin, { exact: true }).isVisible(), true, 'The reason is explained in plain words');
    assert.match(await same.innerText(), /36\.2/);
    assert.equal(await hero(page).getByTestId('speed-boost-apply').count(), 0);
    await openAdvanced(page);
    await area(page).getByText(text.noChange, { exact: true }).waitFor();
    assert.equal(await area(page).getByRole('button', { name: text.saveVersion, exact: true }).count(), 0);
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
  await run('legacy-report-in-history', 'zh-CN', async (page, text) => {
    await oneFold(page, false);
    await openAdvanced(page);
    assert.equal(await area(page).getByText('历史短请求报告', { exact: true }).isVisible(), true);
    assert.equal(await area(page).locator('.tuning-history-head').isVisible(), true, 'Old short-request reports stay viewable under history');
    assert.equal(await area(page).getByRole('button', { name: text.apply, exact: true }).count(), 0);
    await section(page, text.comparisons);
  }, { job: 'legacy' });
  for (const language of ['zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'ru']) {
    await run(`translated-${language}`, language, async page => {
      await openAdvanced(page);
      const visible = await area(page).evaluate(element => element.innerText);
      assert.doesNotMatch(visible, /\bsb[A-Z]\w+/, 'No raw translation keys');
      assert.doesNotMatch(visible, /\{\{/, 'No unfilled placeholders');
    }, { calibration: 'finished', extra: '&health=low' });
  }
} finally { await browser?.close(); await server.close(); }
await writeFile(resolve(output, selectedCase ? `browser-results-${selectedCase.replace(/[^a-z0-9-]/gi, '')}.json` : 'browser-results.json'), JSON.stringify({ scope: 'Real React App with in-memory tuning jobs, random fixture port and blocked external HTTP. No native supervisor, GPU, model or installed application acceptance.', fixturePort: address.port, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
