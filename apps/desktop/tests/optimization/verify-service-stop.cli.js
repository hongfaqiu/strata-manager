// Run with the isolated fixture server; stop_service is mocked in memory only.
async page => {
  const origin = new URL(page.url()).origin, results = [], errors = [];
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const assert = (value, message) => { if (!value) throw Error(message); };
  const hero = () => page.locator('.overview-service');
  const popup = () => page.locator('.service-status-popover');
  const trigger = () => page.getByRole('button', { name: '服务状态与快捷操作', exact: true });
  for (const scenario of ['success', 'native-error', 'still-running']) {
    const errorStart = errors.length;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const extra = scenario === 'native-error' ? '&stop-fail' : scenario === 'still-running' ? '&stop-still-running' : '';
      await page.goto(`${origin}/service-status-trends-app.html?allow-stop${extra}&case=stop-${scenario}#overview`);
      await page.locator('.boot').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('.overview-service .service-actions button.danger')?.disabled === false);
      assert(await hero().getByRole('button', { name: '启动服务', exact: true }).count() === 0, 'Running service should not offer start');
      await hero().getByRole('button', { name: '停止服务', exact: true }).click();
      if (scenario === 'success') {
        await page.waitForFunction(() => document.querySelector('#pill-text')?.textContent === '未启动');
        await hero().getByRole('button', { name: '启动服务', exact: true }).waitFor();
        assert(await hero().getByRole('button', { name: '启动服务', exact: true }).isEnabled(), 'Stopped service must offer an enabled start action');
        assert(await hero().getByRole('button', { name: '停止服务', exact: true }).count() === 0, 'The stale stop action should disappear after verified stop');
        assert(await hero().getByRole('button', { name: '释放模型内存', exact: true }).count() === 0, 'Stopped service must not offer unload');
        await trigger().click(); await popup().waitFor();
        assert(await popup().getAttribute('data-state') === 'stopped', 'Quick status must confirm stopped');
        assert(await popup().getByRole('button', { name: '启动服务', exact: true }).isEnabled(), 'Quick actions should offer start after stop');
        assert(await popup().getByRole('button', { name: '停止服务', exact: true }).count() === 0, 'Quick actions should not retain stop after stop');
        assert(await popup().locator('.service-status-sparkline').count() === 0, 'Stopped service should not retain a live curve');
      } else {
        await page.locator('.st-toast--error').waitFor();
        const message = await page.locator('.st-toast--error').innerText();
        assert(message.includes('停止') && (message.includes('失败') || message.includes('运行') || message.includes('退出')), 'Failed stop should explain the failure');
        assert(await page.locator('#pill-text').innerText() !== '未启动', 'A failed stop must not fabricate stopped state');
        assert(await hero().getByRole('button', { name: '启动服务', exact: true }).count() === 0, 'A failed stop must not offer start');
        assert(await hero().getByRole('button', { name: '停止服务', exact: true }).isEnabled(), 'A failed stop should retain the usable stop action');
        assert(!await page.evaluate(() => window.__fixture.telemetry.stopped), 'The failed fixture process must stay running');
      }
      const calls = await page.evaluate(() => window.__fixture.calls);
      const stops = calls.filter(call => call.command === 'stop_service');
      const forbidden = calls.filter(call => /^(start_service|restart_service|ensure_local_service|switch_local_service|take_over_service|prepare_app_update|download_app_update|install_app_update|plugin:updater\|download|plugin:updater\|install)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST');
      assert(stops.length === 1 && stops[0].args.profileId === 'a', 'Only the explicit in-memory stop for active profile should run');
      assert(forbidden.length === 0, 'Stopping must not start services or perform other mutations');
      assert(errors.length === errorStart, `Browser errors: ${errors.slice(errorStart).join('; ')}`);
      results.push({ name: `stop-${scenario}`, passed: true, syntheticStops: stops.length, forbiddenMutations: 0, message: scenario === 'success' ? '未启动' : await page.locator('.st-toast--error').innerText() });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/service-status-trends/stop-${scenario}-failure.png` });
      results.push({ name: `stop-${scenario}`, passed: false, error: String(error), browserErrors: errors.slice(errorStart) });
    }
  }
  return { scope: 'Real React App with controlled in-memory stop responses. No real service stop/start, GPU or updater activity.', results, passed: results.every(result => result.passed) };
}
