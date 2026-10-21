// Run with playwright-cli run-code --filename against serve-app-updates.mjs.
async page => {
  const origin = new URL(page.url()).origin, replay = Date.now(), results = [], browserErrors = [];
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const trigger = () => page.getByRole('button', { name: /^(服务状态与快捷操作|Service status and quick actions)$/ });
  const panel = () => page.locator('.service-status-popover');
  const bar = () => page.locator('.service-telemetry-statusbar');
  const graphCount = () => panel().locator('.service-status-trends svg').evaluateAll(elements => elements.map(element => Number(element.dataset.samples)));
  const queryEvidence = () => page.evaluate(() => window.__query.getQueryCache().getAll().filter(query => ['process', 'health', 'metrics'].includes(query.queryKey[0]) && query.isActive()).map(query => ({ key: query.queryKey, status: query.state.status, dataUpdatedAt: query.state.dataUpdatedAt, errorUpdatedAt: query.state.errorUpdatedAt, running: query.state.data?.running, owned: query.state.data?.owned })));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => browserErrors.push(String(error)));
  async function invalidate(key) {
    await page.evaluate(key => { void window.__query.invalidateQueries({ queryKey: [key] }); }, key);
  }
  async function waitQuery(key, status) {
    await page.waitForFunction(({ key, status }) => window.__query.getQueryCache().getAll().some(query => query.queryKey[0] === key && query.isActive() && query.state.status === status && query.state.fetchStatus === 'idle'), { key, status });
  }
  async function openPanel() {
    if (await trigger().getAttribute('aria-expanded') !== 'true') await trigger().click();
    await panel().waitFor();
  }
  async function assertNoCurrentValues() {
    assert(await bar().locator('.service-telemetry-values').count() === 0, 'Stale metrics must not render in the current-value status bar');
    assert(await panel().getByRole('meter').count() === 0, 'Stale resource values must not become meters');
  }
  async function releaseMetrics(sequence) {
    await page.evaluate(sequence => { window.__fixture.telemetry.sequence = sequence; window.__fixture.telemetry.releaseMetrics(); }, sequence);
    await waitQuery('metrics', 'success');
    await page.waitForFunction(() => document.querySelector('.service-telemetry-speed strong')?.textContent.includes('110'));
  }
  async function run(name, extra, action) {
    const errorsBefore = browserErrors.length;
    try {
      await page.goto(`${origin}/service-status-trends-app.html?${extra}&case=${name}&replay=${replay}#overview`);
      await page.locator('.boot').waitFor({ state: 'hidden' });
      await trigger().waitFor();
      await waitQuery('process', 'success');
      if (!extra.includes('stopped')) await waitQuery('metrics', 'success');
      await page.evaluate(() => {
        window.__guard = { failHealth: false, failProcess: false };
        const previous = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
          const fail = command === 'service_status' && window.__guard.failProcess || command === 'strata_request' && args.path === '/health' && window.__guard.failHealth;
          if (fail) { window.__fixture.calls.push({ command, args: structuredClone(args) }); throw Error('Isolated verification failure'); }
          return previous(command, args);
        };
      });
      const evidence = await action();
      const mutations = await page.evaluate(() => window.__fixture.calls.filter(call => /^(start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service|prepare_app_update|download_app_update|install_app_update|plugin:updater\|download|plugin:updater\|install)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST'));
      assert(mutations.length === 0, `Unexpected mutations: ${JSON.stringify(mutations)}`);
      assert(browserErrors.length === errorsBefore, `Browser errors: ${browserErrors.slice(errorsBefore).join('; ')}`);
      await page.screenshot({ path: `output/playwright/service-status-faults/${name}.png` });
      results.push({ name, passed: true, mutations: 0, ...evidence });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/service-status-faults/${name}-failure.png` });
      results.push({ name, passed: false, error: String(error), queries: await queryEvidence(), browserErrors: browserErrors.slice(errorsBefore) });
    }
  }
  await run('same-pid-health-recovery-awaits-fresh-metrics', '', async () => {
    await openPanel();
    const before = await queryEvidence(), historyBefore = await graphCount();
    await page.evaluate(() => { window.__guard.failHealth = true; });
    await invalidate('health'); await waitQuery('health', 'error');
    const failure = await queryEvidence();
    const failedHealth = failure.find(query => query.key[0] === 'health');
    assert(failedHealth.errorUpdatedAt > 0, 'The health failure must record a real query timestamp');
    await page.evaluate(() => { window.__fixture.telemetry.holdMetrics = true; window.__guard.failHealth = false; });
    await invalidate('health'); await waitQuery('health', 'success');
    await page.waitForFunction(() => window.__fixture.telemetry.heldReads > 0);
    await page.waitForFunction(() => document.querySelector('.service-status-monitor')?.dataset.paused === 'true');
    const delayed = await queryEvidence(), delayedHealth = delayed.find(query => query.key[0] === 'health'), delayedMetrics = delayed.find(query => query.key[0] === 'metrics');
    assert(JSON.stringify(delayedHealth.key) === JSON.stringify(before.find(query => query.key[0] === 'health').key), 'PID and creation time must remain identical across health recovery');
    assert(delayedMetrics.dataUpdatedAt <= failedHealth.errorUpdatedAt, 'The regression must retain a pre-outage metrics cache');
    await assertNoCurrentValues();
    assert(JSON.stringify(await graphCount()) === JSON.stringify(historyBefore), 'Health recovery must retain history without appending old samples');
    await releaseMetrics(20);
    assert(await panel().locator('.service-status-monitor').getAttribute('data-paused') === 'false', 'Only a fresh metric response may restore live state');
    const recovered = await queryEvidence();
    assert(recovered.find(query => query.key[0] === 'metrics').dataUpdatedAt > failedHealth.errorUpdatedAt, 'Fresh metrics must be strictly newer than the failure boundary');
    assert((await graphCount()).some((count, index) => count > historyBefore[index]), 'Recovery should append a real new sample');
    return { before, failure, delayed, recovered };
  });
  await run('successful-background-refetch-keeps-values', '', async () => {
    await openPanel();
    const before = await bar().locator('.service-telemetry-values').innerText();
    await page.evaluate(() => { window.__fixture.telemetry.holdMetrics = true; });
    await invalidate('metrics');
    await page.waitForFunction(() => window.__fixture.telemetry.heldReads > 0);
    assert(await bar().locator('.service-telemetry-values').innerText() === before, 'A normal pending refetch must not clear successful values');
    assert(await panel().locator('.service-status-monitor').getAttribute('data-paused') === 'false', 'A successful cached query must not flash as paused');
    assert(await panel().getByRole('meter', { name: '显存', exact: true }).count() === 1, 'Normal refetch must retain resource meters');
    await releaseMetrics(20);
    return { before, after: await bar().locator('.service-telemetry-values').innerText() };
  });
  await run('failed-metrics-retry-keeps-cache-hidden', '', async () => {
    await openPanel();
    await page.evaluate(() => { window.__fixture.telemetry.failMetrics = true; });
    await invalidate('metrics'); await waitQuery('metrics', 'error');
    await page.waitForFunction(() => document.querySelector('.service-status-monitor')?.dataset.paused === 'true');
    await assertNoCurrentValues();
    const failed = await queryEvidence();
    await page.evaluate(() => { Object.assign(window.__fixture.telemetry, { failMetrics: false, holdMetrics: true }); });
    await invalidate('metrics');
    await page.waitForFunction(() => window.__fixture.telemetry.heldReads > 0);
    await assertNoCurrentValues();
    await releaseMetrics(20);
    return { failed, recovered: await queryEvidence() };
  });
  for (const stopped of [false, true]) for (const language of ['zh-CN', 'en']) await run(`process-rpc-error-${stopped ? 'stopped' : 'running'}-${language}`, `${stopped ? 'stopped&' : ''}language=${language}`, async () => {
    await openPanel();
    await page.evaluate(() => { window.__guard.failProcess = true; });
    await invalidate('process'); await waitQuery('process', 'error');
    await page.waitForFunction(() => document.querySelector('.service-status-popover')?.dataset.state === 'unverified' && document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'unverified');
    const failed = await queryEvidence(), cached = failed.find(query => query.key[0] === 'process');
    assert(cached.running === !stopped && cached.owned === !stopped, 'The old cache must remain in QueryClient to prove the failure path');
    assert((await page.locator('#pill-text').innerText()).includes(language === 'en' ? 'unverified' : '待核验'), 'Process errors must be labelled unverified');
    assert(await panel().locator('.service-status-owner').count() === 0, 'Cached ownership must not appear in the UI');
    await assertNoCurrentValues();
    const actions = await panel().locator('.service-status-actions button').evaluateAll(elements => elements.map(element => ({ text: element.textContent, disabled: element.matches(':disabled') })));
    assert(actions.length > 0 && actions.every(action => action.disabled), 'Unknown status must not enable lifecycle actions');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { location.hash = '#tuning'; });
    await page.locator('[data-testid=tuning-start]').waitFor();
    assert(await page.locator('[data-testid=tuning-start]').isDisabled(), 'Cached ownership must not enable tuning');
    await page.evaluate(() => { location.hash = '#overview'; });
    await trigger().waitFor();
    await page.evaluate(() => { window.__guard.failProcess = false; if (!window.__fixture.telemetry.stopped) window.__fixture.telemetry.holdMetrics = true; });
    await invalidate('process'); await waitQuery('process', 'success');
    if (stopped) {
      await page.waitForFunction(() => document.querySelector('#pill-text')?.textContent === (window.__fixture.store.settings.language === 'en' ? 'Not started' : '未启动'));
      await openPanel();
      assert(await panel().locator('.service-status-actions button').first().isEnabled(), 'Fresh stopped status must restore the explicit start action');
    } else {
      await page.waitForFunction(() => window.__fixture.telemetry.heldReads > 0);
      await openPanel(); await assertNoCurrentValues();
      await releaseMetrics(20);
    }
    return { failed, actions, recovered: await queryEvidence() };
  });
  return { scope: 'Real React App in Chromium; isolated synthetic Tauri IO; no real service/GPU/updater mutations.', results, passed: results.every(result => result.passed) };
}
