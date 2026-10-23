// Replay real production main.tsx with dedicated in-memory native window IO.
async page => {
  const origin = new URL(page.url()).origin, results = [], errors = [], replay = Date.now();
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const assert = (value, message) => { if (!value) throw Error(message); };
  const bar = () => page.locator('.floating-monitor-content');
  const speed = () => bar().locator('[data-metric="generation"] strong');
  const sampleTime = () => bar().locator('.floating-monitor-content-header > span:last-child');
  const hiddenMeasurements = async () => (await bar().locator('.floating-monitor-reading strong').allTextContents()).every(value => value === '—');
  const waitForRate = () => page.waitForFunction(() => {
    const value = Number(document.querySelector('[data-metric="generation"] strong')?.textContent);
    return value >= 48 && value <= 72;
  });
  const currentRate = async () => Number(await speed().innerText());
  async function preferences(value) {
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-preferences-changed'));
    await page.evaluate(value => window.__fixture.emitPreferences(value), value);
    await page.waitForFunction(() => window.__fixture.monitor.size?.width === 588 && window.__fixture.monitor.size?.height === 152);
    await page.setViewportSize({ width: 588, height: 152 });
  }
  async function openMenu(rightClick = false) {
    const before = await page.evaluate(() => window.__fixture.monitor.popups.length);
    if (rightClick) await page.locator('.floating-telemetry-window').click({ button: 'right', position: { x: 16, y: 12 } });
    else { await page.locator('.floating-telemetry-window').focus(); await page.locator('.floating-telemetry-window').press('Shift+F10'); }
    await page.waitForFunction(before => window.__fixture.monitor.popups.length > before, before);
    return page.evaluate(() => ({ menu: window.__fixture.monitor.menus.at(-1), popup: window.__fixture.monitor.popups.at(-1) }));
  }
  async function chooseMenu(id) { await page.evaluate(id => window.__fixture.selectMenu(id), id); }
  async function assertDefaultMetrics() {
    const evidence = await page.evaluate(() => {
      const root = document.querySelector('.floating-telemetry-window').getBoundingClientRect();
      const values = document.querySelector('.floating-monitor-grid');
      const nodes = [...document.querySelectorAll('.floating-monitor-cell')];
      return { width: innerWidth, height: innerHeight, valuesFit: values.scrollWidth <= values.clientWidth,
        metrics: nodes.map(node => { const rect = node.getBoundingClientRect(); const value = node.querySelector('strong').getBoundingClientRect(); return { visible: getComputedStyle(node).display !== 'none' && rect.width > 0 && rect.height > 0, inside: value.left >= root.left && value.right <= root.right && value.top >= root.top && value.bottom <= root.bottom, contentFits: node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight }; }) };
    });
    assert(evidence.width === 588 && evidence.height === 152, 'Default two-row monitor must fit its 588×152 native size');
    assert(evidence.valuesFit && evidence.metrics.length === 6 && evidence.metrics.every(metric => metric.visible && metric.inside && metric.contentFits), 'All six default metrics must be visible without clipping or horizontal scrolling');
    const requested = await page.evaluate(() => window.__fixture.monitor.size);
    assert(requested?.width === 588 && requested?.height === 152, 'Renderer must request the matching fixed logical window size');
  }
  async function run(name, query, action, viewport = { width: 588, height: 152 }, main = false) {
    const errorStart = errors.length;
    try {
      await page.setViewportSize(viewport);
      const entry = main ? query.includes('floating-settings') ? 'monitor-settings-app.html' : 'service-status-trends-app.html' : 'floating-monitor-app.html';
      await page.goto(`${origin}/${entry}?${main ? '' : 'window=monitor&'}${query}&case=${name}&replay=${replay}#overview`);
      if (main) await page.locator('.boot').waitFor({ state: 'hidden' });
      else {
        await page.locator('.floating-telemetry-window').waitFor();
        await page.waitForFunction(() => window.__fixture.monitor.reads > 0 && document.documentElement.dataset.window === 'monitor');
      }
      const evidence = await action();
      const calls = await page.evaluate(() => window.__fixture.calls);
      assert(!calls.some(call => /^(start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service|prepare_app_update)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST'), 'Monitor must not mutate service lifecycle');
      if (!main) assert(!calls.some(call => ['supervisor_status', 'service_status', 'strata_request', 'strata_stream', 'ensure_supervisor', 'upgrade_supervisor'].includes(call.command)), 'Floating window must use only its dedicated read-only snapshot command');
      assert(errors.length === errorStart, `Browser errors: ${errors.slice(errorStart).join('; ')}`);
      results.push({ name, passed: true, forbiddenMutations: 0, ...evidence });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/service-status-trends/${name}-failure.png` });
      results.push({ name, passed: false, error: String(error), browserErrors: errors.slice(errorStart) });
    }
  }
  await run('floating-generation-and-window-actions', '', async () => {
    await waitForRate();
    assert(await currentRate() >= 48 && await currentRate() <= 72, 'Generation should show the current synthetic snapshot rate');
    const gpu = Number(await bar().locator('[data-metric="gpu"] strong').innerText());
    assert(gpu >= 25 && gpu <= 45, 'Floating hardware must match the dynamic snapshot range');
    assert(await page.locator('.floating-telemetry-drag, [data-tauri-drag-region]').count() === 0, 'Floating monitor must have no dedicated drag region');
    assert(await sampleTime().innerText() === '', 'Monitor should hide the sample time by default');
    assert(await page.getByRole('button', { name: 'Fixture A', exact: true }).count() === 0 && !(await page.locator('.floating-telemetry-window').innerText()).includes('Fixture A'), 'Floating header must not display a model name');
    assert(await page.locator('.floating-telemetry-window button').count() === 0, 'Monitor must display no shortcut, tray, menu or close buttons');
    await assertDefaultMetrics();
    await page.screenshot({ path: 'output/playwright/service-status-trends/floating-light.png' });
    const pinStart = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'plugin:window|set_always_on_top').length);
    await openMenu(true); await chooseMenu('pin');
    await page.waitForFunction(() => window.__fixture.monitor.pinned === false);
    await openMenu(); await chooseMenu('pin');
    await page.waitForFunction(() => window.__fixture.monitor.pinned === true);
    for (const id of ['main', 'chat', 'monitoring']) { await openMenu(); await chooseMenu(id); }
    const readStart = await page.evaluate(() => window.__fixture.monitor.reads);
    await openMenu(); await chooseMenu('refresh');
    await page.waitForFunction(before => window.__fixture.monitor.reads > before, readStart);
    await openMenu(); await chooseMenu('close');
    const controls = await page.evaluate(pinStart => ({ pins: window.__fixture.calls.filter(call => call.command === 'plugin:window|set_always_on_top').slice(pinStart).map(call => ({ label: call.args.label, value: call.args.value })), closed: window.__fixture.monitor.closed, shownMain: window.__fixture.monitor.shownMain, destinations: window.__fixture.monitor.destinations }), pinStart);
    assert(JSON.stringify(controls.pins) === JSON.stringify([{ label: 'service-monitor', value: false }, { label: 'service-monitor', value: true }]), 'Pin toggles must target only the monitor window');
    assert(controls.closed && controls.shownMain === 3 && controls.destinations.slice(-2).join(',') === 'chat,monitoring', 'Close, show-main and navigation controls must invoke their dedicated window actions');
    return controls;
  });
  await run('floating-right-click-native-menu-and-navigation', 'state=idle', async () => {
    await speed().waitFor();
    const { menu, popup } = await openMenu(true);
    const expected = ['main', 'chat', 'monitoring', 'usage', 'tasks', 'copyApiUrl', 'quickBenchmark', 'refresh', 'pause', 'pin', 'taskbar', 'settings', 'close'];
    assert(expected.every(id => menu.items.some(item => item.id === id)) && menu.items.filter(item => item.id).length === expected.length, 'Right-click menu must include all shortcuts plus settings and close');
    assert(!menu.items.some(item => item.id === 'taskbar'), 'Native context menu must not offer the removed taskbar mode');
    assert(menu.items.some(item => item.item === 'Separator'), 'Native context menu should separate its groups');
    assert(popup.window === null || popup.window === 'service-monitor', 'Native menu must target the current floating window');
    assert(menu.items.find(item => item.id === 'quickBenchmark').enabled !== false, 'Idle ready model should permit quick speed test');
    const keyboardBefore = await page.evaluate(() => window.__fixture.monitor.popups.length);
    await page.locator('.floating-telemetry-window').focus();
    await page.locator('.floating-telemetry-window').press('Shift+F10');
    await page.waitForFunction(before => window.__fixture.monitor.popups.length > before, keyboardBefore);
    for (const id of ['usage', 'tasks', 'settings', 'quickBenchmark']) {
      await openMenu(); await chooseMenu(id);
      await page.waitForFunction(id => window.__fixture.monitor.destinations.at(-1) === id, id);
    }
    await openMenu(); await chooseMenu('copyApiUrl');
    await page.waitForFunction(() => window.__fixture.copied.length === 1);
    assert(await page.evaluate(() => window.__fixture.copied[0]) === 'http://127.0.0.1:19001', 'Copy API should use the current snapshot endpoint and in-memory clipboard');
    assert(menu.items.find(item => item.id === 'taskbar')?.text === '收起到任务栏监控', 'Native menu must offer moving the strip to the taskbar monitor');
    assert(!menu.items.some(item => item.id === 'tray'), 'The retired tray-monitor entry must be gone');
    await openMenu(); await chooseMenu('taskbar');
    await page.waitForFunction(() => window.__fixture.monitor.taskbarMoves === 1);
    await openMenu(); await chooseMenu('close');
    await page.waitForFunction(() => window.__fixture.monitor.closed);
    return { itemIds: menu.items.filter(item => item.id).map(item => item.id), keyboardMenu: true, destinations: await page.evaluate(() => window.__fixture.monitor.destinations), copied: await page.evaluate(() => window.__fixture.copied) };
  });
  await run('floating-drag-anywhere-without-accidental-actions', 'state=idle', async () => {
    await speed().waitFor();
    const root = page.locator('.floating-telemetry-window');
    for (const [name, target, padding] of [['metric', speed(), false], ['blank', root, true]]) {
      const rect = await target.boundingBox(); assert(rect, name + ' drag target must be visible');
      const start = { x: rect.x + (padding ? 1 : rect.width / 2), y: rect.y + (padding ? 1 : rect.height / 2) };
      const before = await page.evaluate(() => window.__fixture.monitor.drags || 0);
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(start.x + 2, start.y);
      assert(await page.evaluate(() => window.__fixture.monitor.drags || 0) === before, 'Pointer movement below four pixels must not start dragging');
      await page.mouse.move(start.x + 6, start.y); await page.mouse.up();
      await page.waitForFunction(before => window.__fixture.monitor.drags === before + 1, before);
    }
    await root.click({ position: { x: 2, y: 2 } });
    assert(await page.evaluate(() => window.__fixture.monitor.shownMain) === 0, 'Dragging or clicking monitor must not trigger a navigation action');
    const right = await speed().boundingBox();
    await page.mouse.move(right.x + 2, right.y + right.height / 2); await page.mouse.down({ button: 'right' });
    await page.mouse.move(right.x + 8, right.y + right.height / 2); await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => window.__fixture.monitor.popups.length > 0);
    assert(await page.evaluate(() => window.__fixture.monitor.drags) === 2, 'Right-button gestures must open the menu without dragging');
    const calls = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'plugin:window|start_dragging'));
    assert(calls.every(call => call.args.label === 'service-monitor'), 'Every native drag must target the floating window');
    await chooseMenu('taskbar');
    await page.waitForFunction(() => window.__fixture.monitor.taskbarMoves === 1);
    return { dragTargets: ['metric', 'blank'], dragCalls: calls.length, noAccidentalNavigation: true, taskbarMenu: true };
  });
  await run('floating-taskbar-move-stops-window-polling-and-restores-fresh-sample', '', async () => {
    await speed().waitFor();
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-restored'));
    const dock = async () => { await openMenu(true); await chooseMenu('taskbar'); };
    await dock();
    await page.waitForFunction(() => window.__fixture.monitor.taskbarMoves === 1);
    const dockedReads = await page.evaluate(() => window.__fixture.monitor.reads);
    await page.waitForTimeout(1250);
    assert(await page.evaluate(() => window.__fixture.monitor.reads) === dockedReads, 'Docked floating window must stop its own snapshot polling');
    async function restoreWithDelayedSample() {
      const before = await page.evaluate(() => {
        const before = window.__fixture.monitor.heldSnapshots;
        window.__fixture.monitor.holdSnapshot = true;
        window.__fixture.emitEvent('monitor-restored', null);
        return before;
      });
      await page.waitForFunction(before => window.__fixture.monitor.heldSnapshots > before, before, { timeout: 750 });
      assert(await hiddenMeasurements(), 'Restoring the monitor must hide cached metrics until its fresh response arrives');
      assert((await bar().innerText()).includes('等待新采样'), 'Restored monitor must explain its pending fresh sample');
      await page.evaluate(() => window.__fixture.monitor.releaseSnapshot());
      await waitForRate();
      assert(await currentRate() >= 48 && await currentRate() <= 72, 'Restored floating window must display the newly received sample');
    }
    await restoreWithDelayedSample();
    // Dock again while the preceding snapshot is still fresh: restoration must
    // explicitly refetch instead of relying on the query stale timer.
    await dock();
    await page.waitForFunction(() => window.__fixture.monitor.taskbarMoves === 2);
    await restoreWithDelayedSample();
    return { dockedReads, pollingStopped: true, delayedRestores: 2, freshCacheRestore: true };
  });
  for (const [name, query] of [['generating', ''], ['reading', 'state=reading'], ['queued', 'state=idle&queued'], ['unloaded', 'unloaded&state=idle'], ['stopped', 'stopped']]) {
    await run(`floating-quick-speed-disabled-${name}`, query, async () => {
      const { menu } = await openMenu();
      assert(menu.items.find(item => item.id === 'quickBenchmark')?.enabled === false, 'Quick speed test must be disabled without a ready idle model');
      assert(await page.evaluate(() => window.__fixture.monitor.destinations.length) === 0, 'Disabled quick speed test must not navigate or submit a stream');
      return {};
    });
  }
  await run('floating-pause-and-immediate-preference-events', '', async () => {
    await speed().waitFor(); await openMenu(); await chooseMenu('pause');
    await page.waitForFunction(() => document.querySelector('.floating-telemetry-window')?.textContent.includes('暂停'));
    assert(await hiddenMeasurements(), 'Paused monitor must hide live measurements');
    const pausedReads = await page.evaluate(() => window.__fixture.monitor.reads);
    await page.waitForTimeout(1250);
    assert(await page.evaluate(() => window.__fixture.monitor.reads) === pausedReads, 'Pause must stop automatic snapshot polling');
    await preferences({ actions: ['usage', 'copyApiUrl'], alwaysOnTop: false, showSampleTime: false });
    assert(await page.locator('.floating-telemetry-window button').count() === 0, 'Legacy shortcut preferences must not restore buttons while paused');
    assert(await sampleTime().innerText() === '', 'Preference events must remove the sample time while paused');
    await page.waitForFunction(() => window.__fixture.monitor.pinned === false);
    const { menu } = await openMenu();
    assert(menu.items.find(item => item.id === 'pause')?.text.includes('恢复'), 'Paused native menu must offer resume sampling');
    await page.evaluate(() => { window.__fixture.monitor.holdSnapshot = true; });
    await chooseMenu('pause');
    await page.waitForFunction(() => window.__fixture.monitor.heldSnapshots > 0);
    assert(await hiddenMeasurements(), 'Resume must hide the previous sample until a new snapshot response arrives');
    assert((await page.locator('.floating-telemetry-window').innerText()).includes('等待新采样'), 'Resume must explain why fresh metrics are pending');
    await page.evaluate(() => window.__fixture.monitor.releaseSnapshot());
    await waitForRate();
    await page.waitForFunction(before => window.__fixture.monitor.reads > before, pausedReads);
    assert(await currentRate() >= 48 && await currentRate() <= 72, 'Resume must fetch and display a new real sample');
    return { pausedReads, resumedReads: await page.evaluate(() => window.__fixture.monitor.reads), oldMetricsHiddenDuringResume: true };
  });
  await run('floating-legacy-shortcuts-ignored-and-sample-time-size', '', async () => {
    await speed().waitFor();
    await preferences({ actions: ['copyApiUrl', 'pause', 'usage', 'refresh', 'chat', 'pin'], alwaysOnTop: true, showSampleTime: false });
    await assertDefaultMetrics();
    assert(await page.locator('.floating-telemetry-window button').count() === 0, 'Legacy six-shortcut settings must not render any buttons');
    assert(await sampleTime().innerText() === '', 'Disabled sample time should not render');
    await preferences({ actions: ['copyApiUrl', 'pause', 'usage', 'refresh', 'chat', 'pin'], alwaysOnTop: true, showSampleTime: true });
    await page.waitForFunction(() => /\d{1,2}:\d{2}:\d{2}/.test(document.querySelector('.floating-monitor-content-header > span:last-child')?.textContent || ''));
    assert((await page.evaluate(() => window.__fixture.monitor.size)).width === 588, 'Sample time must fit the default header without changing metric layout');
    await openMenu(); await chooseMenu('copyApiUrl');
    await page.waitForFunction(() => window.__fixture.copied.length === 1);
    await preferences({ actions: [], alwaysOnTop: true, showSampleTime: false });
    await page.waitForFunction(() => window.__fixture.monitor.size?.width === 588);
    assert(await currentRate() >= 48 && await currentRate() <= 72, 'Changing display settings must retain live measurements');
    const { menu } = await openMenu(true); assert(menu.items.some(item => item.id === 'settings'), 'Button-free strip must expose configuration through right-click');
    return { legacyShortcutsIgnored: true, defaultWidth: 588, timeWidth: 588 };
  });
  await run('floating-idle-keeps-rate-historical', 'state=idle', async () => {
    await speed().waitFor(); assert(await currentRate() === 33, 'Idle should show the recent request rate');
    assert((await bar().innerText()).includes('最近生成'), 'Idle rate must retain its historical label'); return {};
  });
  await run('floating-unloaded-does-not-show-cached-speed', 'unloaded', async () => {
    await speed().waitFor(); assert(await speed().innerText() === '—', 'Unloaded snapshot must not show the retained generation rate');
    assert((await bar().innerText()).includes('未加载'), 'Unloaded state must stay explicit'); return {};
  });
  await run('floating-stopped-is-read-only', 'stopped', async () => {
    await page.waitForFunction(() => document.querySelector('.floating-monitor-state')?.textContent.includes('未启动'));
    assert(await hiddenMeasurements(), 'Stopped service must not display stale measurements');
    assert((await bar().innerText()).includes('未启动'), 'Stopped service must say not started');
    await page.waitForFunction(() => window.__fixture.monitor.reads >= 2); return { snapshots: await page.evaluate(() => window.__fixture.monitor.reads) };
  });
  await run('floating-metric-failure-keeps-api-connection', 'unavailable', async () => {
    await page.waitForFunction(() => document.querySelector('.floating-monitor-content-header')?.textContent.includes('监控不可用'));
    assert((await bar().innerText()).includes('监控不可用'), 'Metrics failure with retained health must not imply an offline API');
    assert(await hiddenMeasurements(), 'Unavailable metrics must not show old live values'); return {};
  });
  await run('floating-failure-and-stale-hide-old-metrics', '', async () => {
    await speed().waitFor(); await page.evaluate(() => { window.__fixture.monitor.fail = true; });
    await page.waitForFunction(() => document.querySelector('.floating-monitor-content-header > span:last-child')?.getAttribute('title') === '后台不可用');
    assert(await hiddenMeasurements(), 'A failed snapshot must not keep old live values');
    await page.evaluate(() => { window.__fixture.monitor.fail = false; });
    await waitForRate(); assert(await currentRate() >= 48 && await currentRate() <= 72, 'Recovery should show a new valid sample');
    await page.evaluate(() => { window.__fixture.monitor.stale = true; });
    await page.waitForFunction(() => document.querySelector('.floating-monitor-content-header > span:last-child')?.getAttribute('title') === '等待新采样');
    assert(await hiddenMeasurements(), 'A stale snapshot must not keep old live values'); return {};
  });
  await run('floating-narrow-dark-english', 'language=en&theme=dark', async () => {
    await speed().waitFor();
    assert(await page.locator('html').getAttribute('data-theme') === 'dark' && await page.locator('html').getAttribute('lang') === 'en', 'Monitor must apply stored language/theme');
    const { menu } = await openMenu(true);
    assert(menu.items.find(item => item.id === 'taskbar')?.text === 'Move to taskbar monitor', 'English monitor menu must remain available');
    await assertDefaultMetrics();
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, rect: (() => { const rect = document.querySelector('.floating-telemetry-window').getBoundingClientRect(); return { width: rect.width, height: rect.height }; })() }));
    assert(dimensions.scrollWidth <= dimensions.width && dimensions.scrollHeight <= dimensions.height && dimensions.rect.width <= dimensions.width && dimensions.rect.height <= dimensions.height, 'Floating content must fit a narrow native-sized window');
    assert(await page.locator('.floating-telemetry-window button').count() === 0, 'English monitor must also have no inline buttons');
    await page.screenshot({ path: 'output/playwright/service-status-trends/floating-narrow-dark.png' }); return dimensions;
  }, { width: 588, height: 152 });
  await run('main-window-opens-floating-monitor', '', async () => {
    await page.getByRole('button', { name: '打开监控浮条', exact: true }).waitFor();
    await page.getByRole('button', { name: '打开监控浮条', exact: true }).click();
    const opened = await page.evaluate(() => window.__fixture.openedMonitors || 0); assert(opened === 1, 'Main status bar must call the dedicated open-monitor command once'); return { opened };
  }, { width: 1440, height: 900 }, true);
  await run('main-window-monitor-navigation-events', 'state=idle', async () => {
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-navigate'));
    for (const destination of ['chat', 'monitoring', 'usage', 'tasks', 'settings']) {
      await page.evaluate(destination => window.__fixture.emitEvent('monitor-navigate', destination), destination);
      await page.waitForURL(url => url.hash === `#${destination === 'monitoring' ? 'monitor' : destination === 'settings' ? 'monitor-settings' : destination}`);
      if (destination === 'settings') await page.locator('#settings-floating-monitor').waitFor();
    }
    return { destinations: ['chat', 'monitoring', 'usage', 'tasks', 'settings'], finalHash: await page.evaluate(() => location.hash) };
  }, { width: 1440, height: 1000 }, true);
  await run('main-window-floating-settings-save-reload', 'floating-settings&state=idle', async () => {
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-navigate'));
    await page.evaluate(() => window.__fixture.emitEvent('monitor-navigate', 'settings'));
    const panel = page.locator('#settings-floating-monitor'); await panel.waitFor();
    assert(await panel.getByRole('switch').count() === 5, 'Settings must expose graph, label, unit, sample-time and topmost options');
    assert(await panel.getByRole('checkbox').count() === 11, 'Settings must offer all eleven supported metrics');
    await panel.getByRole('switch', { name: '浮条置顶', exact: true }).click();
    await panel.getByRole('switch', { name: '采样时间', exact: true }).click();
    assert(await panel.locator('summary').filter({ hasText: '更多设置' }).count() === 0, 'The retired tray-monitor toggle must be gone');
    const expected = {
      actions: [], alwaysOnTop: false, showSampleTime: true,
      fontSize: 16, layout: 'strip', rows: 'double', metrics: ['generation', 'prefill', 'gpu', 'vram', 'cpu', 'ram'],
      showGraphs: true, showLabels: true, showUnits: true, mode: 'floating',
    };
    await page.waitForFunction(expected => JSON.stringify(window.__fixture.store.settings.floatingMonitor) === JSON.stringify(expected), expected);
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set' && call.args.key === 'settings' && call.args.value.floatingMonitor?.showSampleTime === true));
    const persisted = await page.evaluate(() => window.__fixture.store.settings.floatingMonitor);
    await page.reload(); await page.locator('.boot').waitFor({ state: 'hidden' }); await panel.waitFor();
    assert(JSON.stringify(await page.evaluate(() => window.__fixture.store.settings.floatingMonitor)) === JSON.stringify(expected), 'Display settings must survive a real page reload');
    assert(await panel.getByRole('switch', { name: '采样时间', exact: true }).getAttribute('aria-checked') === 'true', 'Reloaded settings must reflect the sample-time option');
    await panel.getByRole('button', { name: '打开浮动条', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'set_monitor_mode' && call.args.mode === 'floating'));
    await page.screenshot({ path: 'output/playwright/service-status-trends/floating-settings.png', fullPage: true });
    return { persisted, reopened: 1 };
  }, { width: 1440, height: 1000 }, true);
  await run('main-window-monitor-customization-and-keyboard-order', 'floating-settings&state=idle', async () => {
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-navigate'));
    await page.evaluate(() => window.__fixture.emitEvent('monitor-navigate', 'settings'));
    const panel = page.locator('#settings-floating-monitor');
    await panel.getByRole('button', { name: '详细面板 更多指标', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.metrics?.length === 8);
    assert(await panel.getByRole('checkbox', { name: '排队', exact: true }).isDisabled(), 'Eight metrics must disable adding a ninth metric');
    const slider = panel.getByRole('slider', { name: '监控字号', exact: true });
    await slider.focus(); await slider.press('End');
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.fontSize === 24);
    await panel.getByRole('button', { name: '上移GPU', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.metrics?.[1] === 'gpu');
    await panel.getByRole('checkbox', { name: 'GPU', exact: true }).focus();
    await panel.getByRole('checkbox', { name: 'GPU', exact: true }).press('Alt+ArrowDown');
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.metrics?.[2] === 'gpu');
    await panel.getByRole('checkbox', { name: '读取', exact: true }).uncheck();
    await panel.getByRole('checkbox', { name: '最近缓存', exact: true }).check();
    await panel.getByRole('switch', { name: '实时折线', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.showGraphs === false && window.__fixture.store.settings.floatingMonitor?.metrics?.at(-1) === 'cache');
    const persisted = await page.evaluate(() => window.__fixture.store.settings.floatingMonitor);
    assert(persisted.layout === 'panel' && persisted.fontSize === 24 && persisted.metrics.length === 8, 'Preset, font and metric ordering must be persisted together');
    assert(await panel.getByRole('radio', { name: '单行', exact: true }).isDisabled(), 'The panel is a grid, so 文字行数 must be disabled');
    assert(await panel.getByRole('button', { name: /紧凑单行|清晰双行/ }).count() === 0, 'Only the 条形 and 详细面板 presets remain');
    assert((await panel.locator('.floating-monitor-settings-preview').innerText()).includes('示例数据'), 'Settings preview must explicitly identify synthetic data');
    await page.reload(); await page.locator('.boot').waitFor({ state: 'hidden' }); await panel.waitFor();
    assert(JSON.stringify(await page.evaluate(() => window.__fixture.store.settings.floatingMonitor)) === JSON.stringify(persisted), 'Customized preferences must survive reload');
    await panel.getByRole('button', { name: '恢复显示默认', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.layout === 'strip' && window.__fixture.store.settings.floatingMonitor?.rows === 'double' && window.__fixture.store.settings.floatingMonitor?.fontSize === 16);
    // 条形 + 文字行数: one row is saved separately from the preset and survives re-applying 条形.
    await panel.getByRole('radio', { name: '单行', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.rows === 'single');
    await panel.getByRole('button', { name: '条形 默认推荐', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.layout === 'strip' && window.__fixture.store.settings.floatingMonitor?.rows === 'single');
    await panel.getByRole('radio', { name: '两行', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.rows === 'double');
    return { keyboardOrder: true, maximumMetrics: 8, persisted };
  }, { width: 1200, height: 1000 }, true);
  await run('main-window-monitor-settings-without-taskbar-switch', 'floating-settings&state=idle', async () => {
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-navigate'));
    await page.evaluate(() => window.__fixture.emitEvent('monitor-navigate', 'settings'));
    const panel = page.locator('#settings-floating-monitor'); await panel.waitFor();
    assert(await panel.getByRole('radio', { name: /常驻任务栏|桌面浮条/ }).count() === 0, 'Settings must not expose a monitor mode switch');
    assert(!(await panel.innerText()).includes('常驻任务栏'), 'Settings must not advertise the removed taskbar mode');
    await panel.getByRole('switch', { name: '显示监控', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'set_monitor_visibility' && call.args.visible === true && call.args.mode === 'floating'));
    const calls = await page.evaluate(() => window.__fixture.calls);
    assert(!calls.some(call => ['set_monitor_mode', 'set_monitor_visibility'].includes(call.command) && call.args.mode === 'taskbar'), 'Showing the monitor must always request the floating mode');
    return { taskbarSwitch: false, requestedMode: 'floating' };
  }, { width: 1200, height: 1000 }, true);
  await run('main-window-legacy-taskbar-preference-returns-to-floating', 'floating-settings&state=idle', async () => {
    await page.evaluate(async () => {
      const settings = structuredClone(window.__fixture.store.settings);
      settings.floatingMonitor = { ...settings.floatingMonitor, mode: 'taskbar', metrics: ['cpu'], metricColors: { cpu: '#aabbcc' }, fontSize: 18 };
      await window.__TAURI_INTERNALS__.invoke('store_set', { key: 'settings', value: settings });
    });
    await page.reload(); await page.locator('.boot').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__fixture.store.settings.floatingMonitor?.mode === 'floating');
    const preferences = await page.evaluate(() => window.__fixture.store.settings.floatingMonitor);
    assert(JSON.stringify(preferences.metrics) === '["cpu"]' && preferences.metricColors.cpu === '#aabbcc' && preferences.fontSize === 18, 'Migrating an old taskbar preference must retain appearance and metric colors');
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-navigate'));
    await page.evaluate(() => window.__fixture.emitEvent('monitor-navigate', 'settings'));
    const panel = page.locator('#settings-floating-monitor'); await panel.waitFor();
    assert(await panel.getByRole('radio', { name: /常驻任务栏|桌面浮条/ }).count() === 0, 'An old taskbar preference must not restore the removed switch');
    await panel.getByRole('switch', { name: '显示监控', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'set_monitor_visibility' && call.args.visible === true && call.args.mode === 'floating'));
    assert(!await page.evaluate(() => window.__fixture.calls.some(call => ['set_monitor_mode', 'set_monitor_visibility'].includes(call.command) && call.args.mode === 'taskbar')), 'A legacy preference must not activate the taskbar host');
    return { migratedMode: preferences.mode, preservedMetrics: preferences.metrics, preservedColor: preferences.metricColors.cpu };
  }, { width: 1200, height: 1000 }, true);
  await run('main-window-floating-quick-speed-two-serial-requests', 'state=idle', async () => {
    await page.evaluate(() => { localStorage.removeItem('benchmark-fixture-reports'); window.__fixture.store.benchmarkReportsV1 = []; });
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-navigate'));
    await page.evaluate(() => window.__fixture.emitEvent('monitor-navigate', 'quickBenchmark'));
    await page.waitForURL(url => url.hash === '#benchmark');
    await page.waitForFunction(() => window.__fixture.benchmark.streams.length === 2 && window.__fixture.benchmark.active === 0 && window.__fixture.store.benchmarkReportsV1?.[0]?.state === 'completed');
    const evidence = await page.evaluate(() => ({ streams: window.__fixture.benchmark.streams.map(stream => ({ maxTokens: stream.body.max_tokens, prompt: stream.body.messages[0].content })), peak: window.__fixture.benchmark.peak, events: window.__fixture.benchmark.events, report: window.__fixture.store.benchmarkReportsV1[0] }));
    assert(evidence.peak === 1 && evidence.events.map(event => event.type).join(',') === 'start,end,start,end', 'Quick speed test must send exactly two serial requests');
    assert(evidence.streams.every(stream => stream.maxTokens === 256 && !stream.prompt.includes('/warmup')), 'Quick speed test must cap output to 256 tokens and omit warmup');
    assert(evidence.report.options.scenarios.join(',') === 'short,decode' && evidence.report.options.rounds === 1 && evidence.report.options.warmup === false && evidence.report.samples.length === 2, 'Quick speed test must save its fixed short/decode suite report');
    await page.getByRole('combobox', { name: '历史测试', exact: true }).waitFor();
    await page.screenshot({ path: 'output/playwright/service-status-trends/floating-quick-speed.png', fullPage: true });
    return { requests: evidence.streams.length, peak: evidence.peak, scenarios: evidence.report.options.scenarios, samples: evidence.report.samples.length };
  }, { width: 1440, height: 1000 }, true);
  await run('floating-closed-taskbar-keeps-hidden-sampling-paused', 'dock-close', async () => {
    await page.waitForTimeout(2200);
    const reads = await page.evaluate(() => window.__fixture.monitor.reads);
    await page.waitForTimeout(2200);
    assert(await page.evaluate(() => window.__fixture.monitor.reads) === reads, 'Closing a taskbar host must not resume the still-hidden floating sampler');
    return { snapshotsAfterClose: reads };
  });
  await run('main-window-consecutive-monitor-events-merge', 'floating-settings&state=idle', async () => {
    await page.waitForFunction(() => window.__fixture.hasListener('monitor-preferences-patch'));
    await page.evaluate(() => {
      window.__fixture.emitEvent('monitor-preferences-patch', { metrics: ['cpu'] });
      window.__fixture.emitEvent('monitor-preferences-patch', { showGraphs: false });
      window.__fixture.emitEvent('monitor-preferences-patch', { taskbarEnabled: true });
    });
    await page.waitForFunction(() => {
      const preferences = window.__fixture.store.settings.floatingMonitor;
      return JSON.stringify(preferences?.metrics) === '["cpu"]' && preferences.showGraphs === false && preferences.taskbarEnabled === true && !('showInTray' in preferences);
    });
    const preferences = await page.evaluate(() => window.__fixture.store.settings.floatingMonitor);
    assert(preferences.mode === 'floating', 'Consecutive appearance and taskbar events must keep floating mode');
    return { metrics: preferences.metrics, showGraphs: preferences.showGraphs, taskbarEnabled: preferences.taskbarEnabled, mode: preferences.mode };
  }, { width: 1200, height: 1000 }, true);
  return { scope: 'Exact production React entry in Chromium with synthetic native snapshots, event listeners, native Menu/Channel callbacks, clipboard and window commands. Quick speed inference is synthetic; native topmost/context-menu behavior is not certified by this browser replay.', results, passed: results.every(result => result.passed) };
}
