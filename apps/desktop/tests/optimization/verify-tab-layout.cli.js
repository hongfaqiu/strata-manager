// Replay with an exact named @playwright/cli session against serve-tab-layout.mjs.
// All native IO is synthetic. The script never starts a service or a benchmark.
async page => {
  const origin = new URL(page.url()).origin;
  const failures = [];
  const cases = [];
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  page.on('pageerror', error => failures.push(String(error)));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const routes = [
    ['settings', '.settings-layout'], ['models', '.management-content--models'],
    ['monitoring', '[role="tabpanel"]'], ['usage', '.api-usage-page'],
    ['config', '.startup-tuning'], ['tuning', '.tuning-page'],
    ['benchmark', '.benchmark-workspace'], ['connections', '.shared-settings-target'],
  ];
  const keyboard = async group => {
    const buttons = group.getByRole('radio');
    const count = await buttons.count();
    assert(count > 1, 'Expected multiple segmented options');
    await group.locator('[role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press('Home');
    await page.waitForFunction(element => element.getAttribute('aria-checked') === 'true', await buttons.first().elementHandle());
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(element => element.getAttribute('aria-checked') === 'true', await buttons.nth(1).elementHandle());
    await page.keyboard.press('End');
    await page.waitForFunction(element => element.getAttribute('aria-checked') === 'true', await buttons.last().elementHandle());
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(element => element.getAttribute('aria-checked') === 'true', await buttons.nth(count - 2).elementHandle());
    await page.keyboard.press('Home');
    await page.waitForFunction(element => element.getAttribute('aria-checked') === 'true', await buttons.first().elementHandle());
    await page.waitForFunction(element => element.tabIndex === 0 && document.activeElement === element && !['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(element).backgroundColor), await buttons.first().elementHandle());
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))));
  };
  const measure = async label => {
    const result = await page.evaluate(() => {
      const visible = element => element.getClientRects().length > 0;
      const groups = Array.from(document.querySelectorAll('.official-segmented')).filter(visible).map(group => {
        const box = group.getBoundingClientRect(), style = getComputedStyle(group);
        const buttons = Array.from(group.querySelectorAll(':scope > button')).map(button => {
          const rect = button.getBoundingClientRect();
          return { text: button.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, width: rect.width, grow: getComputedStyle(button).flexGrow, overflow: button.scrollWidth > button.clientWidth + 1 };
        });
        return { label: group.getAttribute('aria-label'), display: style.display, left: box.left, right: box.right, width: box.width, rows: new Set(buttons.map(button => Math.round(button.top))).size, padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth), gap: parseFloat(style.columnGap), buttons };
      });
      const nav = document.querySelector('.workspace-subnav');
      const navBox = nav?.getBoundingClientRect();
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, groups, nav: nav && { width: navBox.width, right: navBox.right, client: nav.clientWidth, scroll: nav.scrollWidth, buttons: nav.querySelectorAll(':scope > button').length } };
    });
    assert(result.documentWidth <= result.viewport + 1, `${label}: document overflows ${result.documentWidth}/${result.viewport}`);
    for (const group of result.groups) {
      assert(group.display === 'flex', `${label}: ${group.label} still uses the legacy grid`);
      assert(group.left >= -1 && group.right <= result.viewport + 1, `${label}: ${group.label} leaves viewport`);
      for (const button of group.buttons) {
        assert(button.grow === '0', `${label}: ${button.text} still stretches`);
        assert(!button.overflow && button.left >= group.left - 1 && button.right <= group.right + 1, `${label}: ${button.text} is clipped`);
      }
      if (group.rows === 1) {
        const contentWidth = group.buttons.reduce((sum, button) => sum + button.width, 0) + group.padding + group.gap * (group.buttons.length - 1);
        assert(group.width <= contentWidth + 2, `${label}: ${group.label} contains unused stretched rail space`);
      }
    }
    if (result.nav) assert(result.nav.right <= result.viewport + 1, `${label}: workspace tabs leave viewport`);
    return result;
  };
  for (const language of ['zh-CN', 'en']) for (const width of [1200, 900, 700]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, selector] of routes) {
      const label = `${language}-${width}-${route}`;
      await page.goto(`${origin}/benchmark-app.html?language=${language}&tab-layout=${Date.now()}#${route}`);
      await page.locator(selector).waitFor();
      await page.waitForFunction(() => !!window.__fixture && !!window.__i18n);
      const groups = page.locator('.official-segmented:visible');
      if (['settings', 'config', 'tuning', 'benchmark'].includes(route) || await groups.count()) {
        await groups.first().waitFor();
        await keyboard(groups.first());
      }
      const layout = await measure(label);
      if (['settings', 'usage', 'benchmark'].includes(route)) await page.screenshot({ path: `output/playwright/tab-layout/${label}.png` });
      if (route === 'benchmark') {
        const mode = page.getByRole('radiogroup', { name: language === 'zh-CN' ? 'Benchmark 类型' : 'Benchmark type', exact: true });
        await mode.getByRole('radio').last().click();
        await page.locator('.benchmark-page:not(.context-benchmark-page):visible').waitFor();
        assert(await mode.getByRole('radio').last().getAttribute('aria-checked') === 'true', `${label}: scenario selection did not apply`);
        layout.scenario = await measure(`${label}-scenario`);
        await page.screenshot({ path: `output/playwright/tab-layout/${label}-scenario.png` });
      }
      if (route === 'connections') {
        await page.getByRole('button', { name: language === 'zh-CN' ? '接入 API' : 'Connect to the API', exact: true }).click();
        const method = page.getByRole('radiogroup', { name: language === 'zh-CN' ? '接入方式' : 'Connection method', exact: true });
        await method.waitFor();
        await keyboard(method);
        layout.dialog = await measure(`${label}-dialog`);
        await page.screenshot({ path: `output/playwright/tab-layout/${label}-dialog.png` });
      }
      if (['settings', 'models', 'monitoring'].includes(route)) {
        const nav = page.locator('.workspace-subnav');
        const last = nav.locator(':scope > button').last();
        const text = await last.textContent();
        await last.focus();
        assert(await last.evaluate(button => {
          const box = button.getBoundingClientRect(), rail = button.parentElement.getBoundingClientRect();
          return document.activeElement === button && box.left >= rail.left - 1 && box.right <= rail.right + 1;
        }), `${label}: last workspace tab is inaccessible by keyboard`);
        await page.keyboard.press('Enter');
        await page.waitForFunction(text => Array.from(document.querySelectorAll('.workspace-subnav > button')).some(button => button.textContent === text && button.getAttribute('aria-current') === 'page'), text);
      }
      cases.push({ language, width, route, layout });
    }
  }
  assert(!failures.length, `Browser errors: ${failures.join('; ')}`);
  return { passed: true, cases: cases.length, widths: [1200, 900, 700], languages: ['zh-CN', 'en'], keyboard: ['ArrowRight', 'ArrowLeft', 'Home', 'End', 'workspace Enter'], browserErrors: failures, details: cases };
}
