// Run via playwright-cli run-code --filename at the isolated fixture origin.
async page => {
  const initialUrl = new URL(page.url()), origin = initialUrl.origin, selection = initialUrl.searchParams.get('verify'), replayId = Date.now(), results = [], errors = [];
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const assert = (value, message) => { if (!value) throw Error(message); };
  const trigger = () => page.getByRole('button', { name: /^(服务状态与快捷操作|Service status and quick actions)$/ });
  const panel = () => page.locator('.service-status-popover');
  const statusbar = () => page.locator('.service-telemetry-statusbar');
  const liveValues = () => statusbar().locator('.service-telemetry-value strong');
  const graph = name => panel().getByRole('img', { name, exact: true });
  const count = async name => await graph(name).count() ? Number(await graph(name).getAttribute('data-samples')) : 0;
  async function update(sequence, changes = {}) {
    await page.evaluate(async ({ sequence, changes }) => {
      Object.assign(window.__fixture.telemetry, { sequence, ...changes });
      await window.__query.invalidateQueries({ queryKey: ['metrics'] });
    }, { sequence, changes });
  }
  async function run(name, query, action, viewport = { width: 1440, height: 900 }, fixture = 'service-status-trends-app.html') {
    if (selection && !new RegExp(selection).test(name)) return;
    const errorStart = errors.length;
    try {
      await page.setViewportSize(viewport);
      // Distinct documents prevent same-URL hash navigation from reusing fixture state.
      await page.goto(`${origin}/${fixture}?${query}&case=${encodeURIComponent(name)}&replay=${replayId}#${fixture === 'app-update-app.html' ? 'updates' : 'overview'}`);
      await page.locator('.boot').waitFor({ state: 'hidden' });
      if (fixture !== 'app-update-app.html') {
        await trigger().waitFor();
        await page.waitForFunction(() => window.__fixture.telemetry.stopped || window.__query.getQueriesData({ queryKey: ['metrics'] }).some(([, value]) => value));
      }
      const evidence = await action();
      const mutations = await page.evaluate(() => window.__fixture.calls.filter(call => /^(start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service|prepare_app_update|plugin:updater\|download|plugin:updater\|install)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST'));
      assert(mutations.length === 0, `Unexpected mutations: ${JSON.stringify(mutations)}`);
      assert(errors.length === errorStart, `Browser errors: ${errors.slice(errorStart).join('; ')}`);
      results.push({ name, passed: true, mutationCount: 0, ...evidence });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/service-status-trends/${name}-failure.png` });
      results.push({ name, passed: false, error: String(error), browserErrors: errors.slice(errorStart) });
    }
  }
  for (const width of [1440, 900]) await run(`updates-fill-content-${width}`, '', async () => {
    await page.locator('.app-updates-settings').waitFor();
    const dimensions = await page.evaluate(() => {
      const card = document.querySelector('.app-updates-settings'), main = document.querySelector('.management-content>.main-content'), style = getComputedStyle(main);
      return { viewport: innerWidth, card: card.getBoundingClientRect().width, available: main.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert(Math.abs(dimensions.card - dimensions.available) <= 2, 'Update card must fill available main-content width');
    assert(!dimensions.horizontalOverflow, 'Update page has horizontal overflow');
    if (width === 1440) await page.screenshot({ path: 'output/playwright/service-status-trends/updates-wide.png' });
    return dimensions;
  }, { width, height: 900 }, 'app-update-app.html');
  await run('generating-history-refresh-and-switch', '', async () => {
    await update(1); await update(2);
    await trigger().click(); await panel().waitFor();
    assert(await panel().getAttribute('data-state') === 'generating', 'Generation phase is missing');
    const before = await count('生成速度趋势');
    assert(before >= 2, 'Collect genuine samples while the popup is closed');
    assert((await statusbar().locator('.service-telemetry-speed strong').innerText()).includes('20'), 'Current generation speed is missing from the status bar');
    assert(await panel().locator('.service-status-kpis,.service-status-issue').count() === 0, 'The popup must not repeat instant KPI values or tuning history');
    const hardware = await Promise.all(['gpu', 'cpu', 'temperature', 'power'].map(name => statusbar().locator(`.service-telemetry-${name} strong`).innerText()));
    assert(JSON.stringify(hardware) === JSON.stringify(['32%', '12%', '48°C', '145 W']), `Status bar hardware values are incorrect: ${JSON.stringify(hardware)}`);
    assert(await statusbar().locator('.service-telemetry-values').evaluate(element => getComputedStyle(element).flexWrap) === 'nowrap', 'Status bar values should occupy one row');
    assert(await panel().getByRole('meter', { name: '显存', exact: true }).getAttribute('aria-valuenow') === '25', 'VRAM aggregate is incorrect');
    assert(await panel().getByRole('meter', { name: '内存', exact: true }).getAttribute('aria-valuenow') === '25', 'RAM aggregate is incorrect');
    await panel().getByRole('button', { name: '刷新状态', exact: true }).click();
    assert(await count('生成速度趋势') >= before, 'Refreshing must preserve the collected trend');
    await page.screenshot({ path: 'output/playwright/service-status-trends/generation-light.png' });
    await page.evaluate(async () => {
      window.__fixture.telemetry.activeProfile = 'b';
      window.__fixture.telemetry.sequence = 0;
      await window.__query.invalidateQueries({ queryKey: ['supervisor'] });
    });
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'strata_request' && call.args.profile?.id === 'b' && call.args.path.startsWith('/metrics')));
    if (!await panel().isVisible()) await trigger().click();
    await page.waitForFunction(() => document.querySelector('.service-status-model')?.textContent === 'Fixture B');
    assert(await count('生成速度趋势') <= 2, 'Switched service must begin its own history');
    assert((await statusbar().locator('.service-telemetry-speed strong').innerText()).includes('210'), 'Switched service should show its own rate');
    return { initialSamples: before, switchedSamples: await count('生成速度趋势') };
  });
  await run('reading-input-trend-dark', 'state=reading&theme=dark', async () => {
    await update(1); await update(2); await trigger().click();
    assert(await panel().getAttribute('data-state') === 'reading', 'Reading phase is missing');
    assert(await count('输入速度趋势') >= 2, 'Prefill must use input-speed samples');
    assert((await statusbar().locator('.service-telemetry-speed strong').innerText()).includes('400'), 'Input rate must come from prefill telemetry');
    assert(await panel().getByRole('meter', { name: '输入处理', exact: true }).getAttribute('aria-valuenow') === '50', 'Input progress must reflect real prompt counts');
    await page.screenshot({ path: 'output/playwright/service-status-trends/reading-dark.png' });
    return { inputSamples: await count('输入速度趋势') };
  });
  await run('idle-does-not-plot-previous-request-speed', 'state=idle', async () => {
    await update(1); await update(2); await trigger().click();
    assert(await panel().getAttribute('data-state') === 'idle', 'Idle phase is missing');
    assert((await statusbar().innerText()).includes('最近生成'), 'Previous rate must be clearly labelled');
    assert(await count('生成速度趋势') === 0, 'Previous request speed must not fabricate new idle trend samples');
    assert(await count('GPU 负载趋势') >= 2, 'Idle service should retain actual hardware samples');
    return {};
  });
  await run('unloaded-has-hardware-without-speed', 'unloaded', async () => {
    await update(1); await update(2); await trigger().click();
    assert((await panel().locator('.service-status-model-state').innerText()).includes('未加载'), 'Unloaded model status is missing');
    assert(await count('生成速度趋势') === 0, 'Unloaded models must not fabricate decode samples');
    assert(await count('GPU 负载趋势') >= 2, 'Unloaded but running service can retain real GPU data');
    assert(await panel().getByRole('button', { name: '加载模型', exact: true }).isEnabled(), 'Managed unloaded service should retain its load action');
    return {};
  });
  await run('stopped-has-no-simulated-curves', 'stopped', async () => {
    await page.waitForFunction(() => document.querySelector('#pill-text')?.textContent === '未启动');
    await trigger().click();
    assert(await panel().getAttribute('data-state') === 'stopped', 'Stopped phase must remain explicit');
    assert(await panel().locator('.service-status-sparkline').count() === 0, 'Stopped services must not show synthetic trends');
    await panel().getByRole('button', { name: '刷新状态', exact: true }).click();
    const requests = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'strata_request'));
    assert(requests.length === 0, 'Stopped refresh must not query or start the service');
    return { serviceRequests: requests.length };
  });
  await run('missing-metrics-remain-unknown', 'missing', async () => {
    await update(1); await trigger().click();
    assert(await panel().locator('.service-status-sparkline').count() === 0, 'Missing metrics must not produce curves');
    const values = await liveValues().allTextContents();
    assert(values.every(value => value.includes('–')), 'Missing metrics must remain unknown rather than zero');
    assert(await statusbar().locator('.service-telemetry-speed strong').innerText() === '–', 'Unknown speed must not appear as zero');
    const meter = panel().locator('.service-status-resources .service-status-meter').first();
    assert(await meter.getAttribute('aria-valuenow') === null, 'Unknown VRAM must not imply measured utilization');
    assert(await meter.locator('span').evaluate(element => element.style.width) === '0%', 'Unknown VRAM meter must not imply measured utilization');
    return { values };
  });
  await run('metric-error-retains-trend-and-recovers', '', async () => {
    await update(1); await update(2); await trigger().click();
    const before = await count('生成速度趋势');
    await update(3, { failMetrics: true });
    await page.waitForFunction(() => document.querySelector('.service-status-popover')?.dataset.state === 'unavailable');
    assert(await count('生成速度趋势') >= before, 'A metrics error must retain previous real samples');
    assert((await panel().innerText()).includes('采集暂停'), 'Paused collection should be visible');
    await update(4, { failMetrics: false });
    assert(await panel().getAttribute('data-state') === 'generating', 'Successful refresh must restore live metrics');
    assert(await count('生成速度趋势') > before, 'Recovery must append a fresh sample');
    return { retainedSamples: before, recoveredSamples: await count('生成速度趋势') };
  });
  await run('restarted-process-waits-for-new-telemetry', '', async () => {
    await update(1); await update(2); await trigger().click(); await panel().waitFor();
    await page.waitForFunction(() => Number(document.querySelector('.service-status-trends svg[aria-label="生成速度趋势"]')?.getAttribute('data-samples') ?? 0) >= 2);
    const oldSamples = await count('生成速度趋势');
    assert(oldSamples >= 2, 'The original instance should have a real collected history');
    await page.evaluate(async () => {
      Object.assign(window.__fixture.telemetry, { instance: 1, sequence: 20, holdMetrics: true });
      await window.__query.invalidateQueries({ queryKey: ['process'] });
    });
    await page.waitForFunction(() => window.__fixture.telemetry.heldReads > 0);
    const delayedValues = await liveValues().allTextContents();
    assert(delayedValues.every(value => value.includes('–')), 'A new process must wait for its own metrics rather than show the old rate');
    assert(await statusbar().locator('.service-telemetry-speed').count() === 0, 'A pending new process must not display a cached speed');
    assert(await count('生成速度趋势') === 0, 'The old process must not contribute samples to the new history');
    const pendingQueries = await page.evaluate(() => window.__query.getQueryCache().getAll().filter(query => ['health', 'metrics'].includes(query.queryKey[0])).map(query => ({ key: query.queryKey, active: query.isActive(), status: query.state.status, dataUpdatedAt: query.state.dataUpdatedAt })));
    assert(pendingQueries.some(query => query.active && query.key[0] === 'metrics' && query.key.includes(100099) && query.key.includes('fixture-instance-1') && query.dataUpdatedAt === 0), 'The pending query must belong to the new PID and creation time');
    await page.evaluate(() => { window.__fixture.telemetry.failMetrics = true; window.__fixture.telemetry.releaseMetrics(); });
    await page.waitForFunction(() => document.querySelector('.service-status-popover')?.dataset.state === 'unavailable');
    assert(await count('生成速度趋势') === 0, 'A failed first sample must not restore the prior process history');
    assert((await liveValues().allTextContents()).every(value => value.includes('–')), 'A failed first sample must not show cached process rates');
    assert(await statusbar().locator('.service-telemetry-speed').count() === 0, 'A failed first sample must not display a cached speed');
    await update(20, { failMetrics: false });
    assert(await panel().getAttribute('data-state') === 'generating', 'Fresh process metrics should restore live state');
    assert((await statusbar().locator('.service-telemetry-speed strong').innerText()).includes('110'), 'The recovered rate must come from the new instance');
    assert(await count('生成速度趋势') === 1, 'The recovered process should begin with one fresh speed sample');
    return { oldSamples, pendingValues: delayedValues, pendingQueries, recoveredSamples: await count('生成速度趋势') };
  });
  for (const width of [1440, 480]) for (const language of ['zh-CN', 'en']) await run(`menu-group-order-${width}-${language}`, `language=${language}`, async () => {
    const zh = language === 'zh-CN', navigation = page.locator('#manager-navigation');
    const expectedGroups = zh ? ['日常使用', '模型与服务', '应用'] : ['Daily use', 'Models & services', 'Application'];
    const expectedItems = zh ? [['总览', '聊天', '监控'], ['模型', 'Strata', '参数调优', '任务与日志'], ['设置']] : [['Overview', 'Chat', 'Monitor'], ['Models', 'Strata', 'Tuning', 'Tasks & logs'], ['Settings']];
    const groups = navigation.getByRole('group');
    assert(await groups.count() === 3, 'The main menu should have three semantic groups');
    for (let index = 0; index < 3; index++) {
      assert(await groups.nth(index).getAttribute('aria-label') === expectedGroups[index], 'Menu groups must retain the intended order and localization');
      const labels = await groups.nth(index).getByRole('button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
      assert(JSON.stringify(labels) === JSON.stringify(expectedItems[index]), `Menu item order is incorrect: ${JSON.stringify(labels)}`);
    }
    assert(await page.locator('.manager-nav-bottom button').count() === 1 && await page.locator('.manager-nav-bottom .nav-collapse').count() === 1, 'The footer should contain only the collapse control');
    const settings = navigation.getByRole('button', { name: expectedItems[2][0], exact: true });
    await settings.click(); await page.waitForFunction(() => location.hash === '#settings');
    assert(await settings.getAttribute('aria-current') === 'page', 'The settings menu must be active on its own page');
    await page.locator('#app-version-button').click(); await page.locator('#settings-app-updates').waitFor();
    assert(await settings.getAttribute('aria-current') === 'page' && await settings.evaluate(element => element.classList.contains('active')), 'App updates must highlight the parent settings menu');
    await page.locator('.nav-collapse').click();
    await page.locator('.manager-nav.is-collapsed').waitFor();
    const divider = await groups.nth(1).locator('.manager-nav-label').evaluate(element => { const style = getComputedStyle(element); return { font: style.fontSize, height: style.height }; });
    assert(divider.font === '0px' && divider.height === '1px', 'Collapsed group labels must become dividers');
    const monitor = navigation.getByRole('button', { name: expectedItems[0][2], exact: true });
    await monitor.click(); await page.waitForFunction(() => ['#monitor', '#monitoring'].includes(location.hash));
    assert(await monitor.getAttribute('aria-current') === 'page', 'Collapsed navigation must remain accessible');
    await settings.click(); await page.waitForFunction(() => location.hash === '#settings');
    await page.locator('#app-version-button').click(); await page.locator('#settings-app-updates').waitFor();
    assert(await settings.getAttribute('aria-current') === 'page', 'Collapsed app updates must still highlight settings');
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Menu and settings must not introduce horizontal overflow');
    return { groups: expectedGroups, items: expectedItems, collapsed: true };
  }, { width, height: 900 });
  await run('small-window-english-position', 'language=en&theme=dark', async () => {
    await update(1); await trigger().click();
    const rect = await panel().boundingBox();
    const anchor = await trigger().boundingBox();
    assert(rect && anchor && rect.x >= 11 && rect.x + rect.width <= 481 && rect.y >= anchor.y + anchor.height + 9 && rect.y + rect.height <= 781, 'Popup must stay inside a small viewport');
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Small popup must not cause horizontal overflow');
    assert(!await statusbar().locator('.service-telemetry-temperature').isVisible() && !await statusbar().locator('.service-telemetry-power').isVisible(), 'Narrow status bar should hide secondary hardware values');
    assert(await statusbar().locator('.service-telemetry-values').evaluate(element => ['auto', 'scroll'].includes(getComputedStyle(element).overflowX)), 'Narrow metrics should scroll within their own row');
    await page.screenshot({ path: 'output/playwright/service-status-trends/small-english-dark.png' });
    return { popup: rect };
  }, { width: 480, height: 800 });
  return { scope: 'Real React App in Chromium with controlled synthetic native telemetry. No services, GPU or updater mutations.', results, passed: results.every(result => result.passed) };
}
