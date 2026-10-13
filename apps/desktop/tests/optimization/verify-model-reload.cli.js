// Playwright CLI replay against the existing isolated native fixtures.
async page => {
  const origin = new URL(page.url()).origin, results = [], errors = [];
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const assert = (value, message) => { if (!value) throw Error(message); };
  const bar = () => page.locator('.service-telemetry-statusbar');
  async function refresh(changes) {
    await page.evaluate(async changes => {
      Object.assign(window.__fixture.telemetry, changes);
      await Promise.all(['health', 'metrics', 'process'].map(key => window.__query.invalidateQueries({ queryKey: [key] })));
    }, changes);
  }
  for (const language of ['zh-CN', 'en']) {
    await page.setViewportSize({ width: language === 'zh-CN' ? 560 : 900, height: 800 });
    await page.goto(`${origin}/service-status-trends-app.html?state=idle&language=${language}#overview`);
    await page.locator('.boot').waitFor({ state: 'hidden' });
    await bar().locator('.service-telemetry-speed').waitFor();
    await refresh({ unloaded: true, state: 'idle' });
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'unloaded');
    assert(await bar().locator('.spin').count() === 0, 'Idle release must not show loading');
    await refresh({ state: 'loading', sequence: 3 });
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'loading');
    assert(await bar().getAttribute('aria-busy') === 'true', 'Reload must announce loading');
    assert(await bar().locator('.spin').count() === 1, 'Reload needs a visible loading indicator');
    assert((await bar().locator('.service-telemetry-load-time').innerText()).includes('15'), 'Reload must show actual loading elapsed time');
    assert(await bar().locator('.service-telemetry-speed').count() === 0, 'Reload must not show historical throughput');
    assert(await page.locator('#pill').getAttribute('data-state') === 'loading', 'Queued requests must not mask loading in the title bar');
    await page.locator('#pill').click();
    assert((await page.locator('.service-status-model-state').innerText()).includes(language === 'zh-CN' ? '载入' : 'Loading'), 'Quick panel must not call a loading model unloaded');
    assert((await page.locator('.service-status-context').innerText()).includes(language === 'zh-CN' ? '自动继续' : 'automatically'), 'Quick panel must explain automatic request resumption');
    await page.locator('#pill').click();
    const visible = await bar().locator('.service-telemetry-state').evaluate(node => {
      const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
    });
    assert(visible, 'Loading state must stay visible in narrow windows');
    await page.screenshot({ path: `output/playwright/model-reload/loading-${language}.png` });
    await refresh({ unloaded: false, state: 'reading' });
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'reading');
    assert(await bar().locator('.spin, .service-telemetry-load-time').count() === 0, 'READY must clear loading visuals');
    await refresh({ state: 'generating' });
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'generating');
    assert(await bar().locator('.service-telemetry-speed').count() === 1, 'Generation must resume live throughput');
    await refresh({ unloaded: true, state: 'unloaded' });
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'unloaded');
    assert(await bar().locator('.spin, .service-telemetry-load-time').count() === 0, 'Failed loading must not leave a stuck indicator');
    await refresh({ state: 'loading', failMetrics: true });
    await page.waitForFunction(() => document.querySelector('.service-telemetry-statusbar')?.dataset.state === 'unavailable');
    assert(await bar().locator('.spin').count() === 0, 'Failed telemetry must not retain cached loading');
    const mutations = await page.evaluate(() => window.__fixture.calls.filter(call => /^(start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST'));
    assert(mutations.length === 0, 'Status reads must never start or reload a real model');
    results.push({ language, passed: true, phases: ['idle', 'unloaded', 'loading', 'reading', 'generating', 'failed-load', 'unavailable'], mutations: mutations.length });
  }
  await page.setViewportSize({ width: 588, height: 173 });
  await page.goto(`${origin}/floating-monitor-app.html?window=monitor&state=loading&unloaded&showStatus#overview`);
  await page.waitForFunction(() => document.querySelector('.floating-monitor-state')?.textContent.includes('载入'));
  assert((await page.locator('[data-metric="generation"] strong').innerText()) === '—', 'Floating reload must hide historical throughput');
  await page.evaluate(() => { window.__fixture.monitor.loaded = true; window.__fixture.monitor.state = 'generating'; });
  await page.waitForFunction(() => document.querySelector('.floating-monitor-state')?.textContent.includes('生成'));
  assert(Number(await page.locator('[data-metric="generation"] strong').innerText()) > 0, 'Floating monitor must resume fresh throughput after READY');
  results.push({ floating: true, passed: true });
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return { passed: true, results, browserErrors: errors };
}
