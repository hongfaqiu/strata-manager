// Replay real production main.tsx with dedicated in-memory native window IO.
async page => {
  const origin = new URL(page.url()).origin, results = [], errors = [], replay = Date.now();
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const assert = (value, message) => { if (!value) throw Error(message); };
  const bar = () => page.locator('.service-telemetry-statusbar');
  const speed = () => bar().locator('.service-telemetry-speed strong');
  async function run(name, query, action, viewport = { width: 760, height: 92 }, main = false) {
    const errorStart = errors.length;
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/${main ? 'service-status-trends-app.html' : 'floating-monitor-app.html'}?${main ? '' : 'window=monitor&'}${query}&case=${name}&replay=${replay}#overview`);
      if (main) await page.locator('.boot').waitFor({ state: 'hidden' });
      else {
        await page.locator('.floating-telemetry-window').waitFor();
        await page.waitForFunction(() => window.__fixture.monitor.reads > 0 && document.documentElement.dataset.window === 'monitor');
      }
      const evidence = await action();
      const calls = await page.evaluate(() => window.__fixture.calls);
      assert(!calls.some(call => /^(start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service|prepare_app_update)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST'), 'Monitor must not mutate service lifecycle');
      if (!main) assert(!calls.some(call => ['supervisor_status', 'service_status', 'strata_request', 'ensure_supervisor', 'upgrade_supervisor'].includes(call.command)), 'Floating window must use only its dedicated read-only snapshot command');
      assert(errors.length === errorStart, `Browser errors: ${errors.slice(errorStart).join('; ')}`);
      results.push({ name, passed: true, forbiddenMutations: 0, ...evidence });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/service-status-trends/${name}-failure.png` });
      results.push({ name, passed: false, error: String(error), browserErrors: errors.slice(errorStart) });
    }
  }
  await run('floating-generation-and-window-actions', '', async () => {
    await speed().waitFor();
    assert(await speed().innerText() === '60.0', 'Generation should show the current real snapshot rate');
    assert(await bar().locator('.service-telemetry-gpu strong').innerText() === '35%', 'Floating hardware must match snapshot');
    assert(await page.locator('.floating-telemetry-drag').getAttribute('data-tauri-drag-region') === 'deep', 'Floating header must retain its native drag region');
    await page.getByRole('button', { name: '取消置顶', exact: true }).click();
    await page.getByRole('button', { name: '置顶浮条', exact: true }).waitFor();
    await page.getByRole('button', { name: '置顶浮条', exact: true }).click();
    await page.getByRole('button', { name: '取消置顶', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Fixture A', exact: true }).click();
    await page.getByRole('button', { name: '关闭浮条', exact: true }).click();
    const controls = await page.evaluate(() => ({ pins: window.__fixture.calls.filter(call => call.command === 'plugin:window|set_always_on_top').map(call => ({ label: call.args.label, value: call.args.value })), closed: window.__fixture.monitor.closed, shownMain: window.__fixture.monitor.shownMain }));
    assert(JSON.stringify(controls.pins) === JSON.stringify([{ label: 'monitor', value: false }, { label: 'monitor', value: true }]), 'Pin toggles must target only the monitor window');
    assert(controls.closed && controls.shownMain === 1, 'Close and show-main controls must invoke their dedicated window actions');
    await page.screenshot({ path: 'output/playwright/service-status-trends/floating-light.png' });
    return controls;
  });
  await run('floating-idle-keeps-rate-historical', 'state=idle', async () => {
    await speed().waitFor(); assert(await speed().innerText() === '33.0', 'Idle should show the recent request rate');
    assert((await bar().innerText()).includes('最近生成'), 'Idle rate must retain its historical label'); return {};
  });
  await run('floating-unloaded-does-not-show-cached-speed', 'unloaded', async () => {
    await speed().waitFor(); assert(await speed().innerText() === '–', 'Unloaded snapshot must not show the retained generation rate');
    assert(await bar().getAttribute('data-state') === 'unloaded', 'Unloaded state must stay explicit'); return {};
  });
  await run('floating-stopped-is-read-only', 'stopped', async () => {
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'stopped');
    assert(await bar().locator('.service-telemetry-values').count() === 0, 'Stopped service must not display stale measurements');
    assert((await bar().innerText()).includes('未启动'), 'Stopped service must say not started');
    await page.waitForFunction(() => window.__fixture.monitor.reads >= 2); return { snapshots: await page.evaluate(() => window.__fixture.monitor.reads) };
  });
  await run('floating-metric-failure-keeps-api-connection', 'unavailable', async () => {
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'unavailable');
    assert((await bar().innerText()).includes('监控不可用'), 'Metrics failure with retained health must not imply an offline API');
    assert(await bar().locator('.service-telemetry-values').count() === 0, 'Unavailable metrics must not show old live values'); return {};
  });
  await run('floating-failure-and-stale-hide-old-metrics', '', async () => {
    await speed().waitFor(); await page.evaluate(() => { window.__fixture.monitor.fail = true; });
    await page.waitForFunction(() => document.querySelector('.floating-telemetry-notice')?.getAttribute('title') === '后台不可用');
    assert(await bar().locator('.service-telemetry-values').count() === 0, 'A failed snapshot must not keep old live values');
    await page.evaluate(() => { window.__fixture.monitor.fail = false; });
    await speed().waitFor(); assert(await speed().innerText() === '60.0', 'Recovery should show a new valid sample');
    await page.evaluate(() => { window.__fixture.monitor.stale = true; });
    await page.waitForFunction(() => document.querySelector('.floating-telemetry-notice')?.getAttribute('title') === '等待新采样');
    assert(await bar().locator('.service-telemetry-values').count() === 0, 'A stale snapshot must not keep old live values'); return {};
  });
  await run('floating-narrow-dark-english', 'language=en&theme=dark', async () => {
    await speed().waitFor();
    assert(await page.locator('html').getAttribute('data-theme') === 'dark' && await page.locator('html').getAttribute('lang') === 'en', 'Monitor must apply stored language/theme');
    assert(await page.getByRole('button', { name: 'Unpin monitor', exact: true }).isEnabled(), 'English monitor controls must be available');
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, rect: (() => { const rect = document.querySelector('.floating-telemetry-window').getBoundingClientRect(); return { width: rect.width, height: rect.height }; })() }));
    assert(dimensions.scrollWidth <= dimensions.width && dimensions.scrollHeight <= dimensions.height && dimensions.rect.width <= dimensions.width && dimensions.rect.height <= dimensions.height, 'Floating content must fit a narrow native-sized window');
    await page.screenshot({ path: 'output/playwright/service-status-trends/floating-narrow-dark.png' }); return dimensions;
  }, { width: 420, height: 92 });
  await run('main-window-opens-floating-monitor', '', async () => {
    await page.getByRole('button', { name: '打开监控浮条', exact: true }).waitFor();
    await page.getByRole('button', { name: '打开监控浮条', exact: true }).click();
    const opened = await page.evaluate(() => window.__fixture.openedMonitors || 0); assert(opened === 1, 'Main status bar must call the dedicated open-monitor command once'); return { opened };
  }, { width: 1440, height: 900 }, true);
  return { scope: 'Exact production React entry in Chromium with synthetic native snapshots/window commands. Native topmost behavior is not certified by this browser replay.', results, passed: results.every(result => result.passed) };
}
