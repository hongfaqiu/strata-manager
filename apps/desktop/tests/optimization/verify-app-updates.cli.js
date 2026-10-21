// Run via playwright-cli run-code --filename after opening the isolated fixture origin.
async page => {
  const origin = new URL(page.url()).origin, results = [], pageErrors = [];
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => pageErrors.push(String(error)));
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const version = () => page.locator('#app-version-button');
  const candidate = () => page.locator('.window-title-bar-update-badge');
  const dialog = () => page.getByRole('dialog');
  const forbidden = /^(?:plugin:updater\|(?:download|install|download_and_install)|download_app_update|install_app_update|prepare_app_update|start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service)$/;
  async function run(name, query, action, viewport = { width: 1366, height: 900 }) {
    const errorStart = pageErrors.length;
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/app-update-app.html?${query}#overview`);
      await version().waitFor();
      await page.locator('.boot').waitFor({ state: 'hidden' });
      assert(await version().isEnabled(), 'Version entry must be interactive after startup');
      await action();
      const mutations = await page.evaluate(pattern => window.__fixture.calls.filter(call => new RegExp(pattern).test(call.command)), forbidden.source);
      assert(mutations.length === 0, `Unexpected lifecycle/updater mutations: ${JSON.stringify(mutations)}`);
      assert(pageErrors.length === errorStart, `Browser errors: ${pageErrors.slice(errorStart).join('; ')}`);
      await page.screenshot({ path: `output/playwright/app-updates/${name}.png`, fullPage: true });
      results.push({ name, passed: true, mutationCount: mutations.length });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/app-updates/${name}-failure.png`, fullPage: true });
      results.push({ name, passed: false, error: String(error), pageErrors: pageErrors.slice(errorStart) });
    }
  }
  await run('default-version-navigates-to-updates', '', async () => {
    assert(await version().innerText() === 'v0.1.3', 'Current package version must be displayed');
    assert(await candidate().count() === 0, 'No candidate badge before checking');
    await version().click();
    await page.locator('#settings-app-updates').waitFor();
    assert(new URL(page.url()).hash === '#updates', 'Version entry must open the dedicated updates page');
    assert(await page.locator('.app-update-version strong').innerText() === 'v0.1.3', 'Updates page current version is missing');
    assert((await page.getByRole('region', { name: '最近一次更新日志', exact: true }).innerText()).includes('聊天加入 JSON / JSON Schema'), 'Installed release notes must use the bundled current release');
    const logo = await page.locator('.window-title-bar-mark').evaluate(element => ({ tag: element.tagName, loaded: element.complete && element.naturalWidth > 0, src: element.getAttribute('src') }));
    assert(logo.tag === 'IMG' && logo.loaded && logo.src.startsWith('data:image/svg+xml'), 'Official application logo must render');
    assert(await page.getByText('登录时启动后台', { exact: true }).count() === 0, 'Updates page must be separate from background settings');
  });
  await run('automatic-badge-and-confirmation-dark', 'automatic&available&theme=dark', async () => {
    await candidate().waitFor();
    assert(await dialog().count() === 0, 'Automatic check must show only the update badge');
    assert((await version().getAttribute('aria-label')).includes('有新版本 v0.2.0'), 'Candidate version must be accessible');
    await page.screenshot({ path: 'output/playwright/app-updates/automatic-badge-before-open-dark.png' });
    await version().click();
    await dialog().waitFor();
    assert((await dialog().innerText()).includes('隔离验收：新版统一应用标识和版本入口'), 'Candidate notes must appear in the review dialog');
    assert((await dialog().innerText()).includes('更新来源: 自动选择 · GHProxy'), 'Chosen update source must be visible in the dialog');
    await dialog().getByRole('button', { name: '稍后', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    assert(await candidate().count() === 1, 'Dismissal must preserve the candidate badge');
    await version().click();
    await dialog().waitFor();
  });
  await run('manual-check-opens-confirmation', 'available', async () => {
    await version().click();
    await page.locator('#settings-app-updates').getByRole('button', { name: '检查更新', exact: true }).click();
    await dialog().waitFor();
    assert(await candidate().count() === 1, 'Manual check must also set the candidate badge');
    await dialog().getByRole('button', { name: '稍后', exact: true }).click();
    await page.getByRole('region', { name: '可用更新日志', exact: true }).waitFor();
    assert((await page.getByRole('region', { name: '可用更新日志', exact: true }).innerText()).includes('隔离验收'), 'Candidate notes must be visible on updates page');
    assert((await page.getByRole('region', { name: '最近一次更新日志', exact: true }).innerText()).includes('聊天加入'), 'Installed and candidate release notes must remain distinct');
    assert((await page.getByText('更新来源: 自动选择 · GHProxy', { exact: true }).count()) >= 1, 'Update source summary must be shown on the settings page');
  });
  await run('collapsed-version-badge-light', 'collapsed&automatic&available', async () => {
    await candidate().waitFor();
    assert(await page.locator('.window-title-bar.is-collapsed').count() === 1, 'Sidebar collapse must reach the title bar');
    const geometry = await version().boundingBox();
    assert(geometry && geometry.x >= 0 && geometry.x + geometry.width <= 73, 'Collapsed version must stay inside the sidebar column');
    const badge = await candidate().boundingBox();
    assert(badge && badge.width <= 6 && badge.height <= 6, 'Collapsed candidate badge must become a dot');
    await page.screenshot({ path: 'output/playwright/app-updates/collapsed-badge-before-open-light.png' });
    await version().click();
    await dialog().waitFor();
  });
  await run('native-version-with-missing-bundled-notes', 'version=9.9.9', async () => {
    await page.waitForFunction(() => document.querySelector('#app-version-button')?.textContent.includes('9.9.9'));
    await version().click();
    assert(await page.locator('.app-update-version strong').innerText() === 'v9.9.9', 'Native version must override package version');
    const notes = await page.getByRole('region', { name: '最近一次更新日志', exact: true }).innerText();
    assert(notes.includes('当前版本的更新日志未包含在此安装包中'), 'Unknown native release needs an explicit missing-notes message');
    assert(!notes.includes('聊天加入 JSON'), 'Unknown native version must not display package release notes');
  });
  await run('english-current-release-dark', 'language=en&theme=dark', async () => {
    await version().click();
    assert(await page.locator('.app-update-version strong').innerText() === 'v0.1.3', 'English update page must show version');
    const notes = await page.getByRole('region', { name: 'Latest installed release notes', exact: true }).innerText();
    assert(notes.includes('Add JSON / JSON Schema responses'), 'English current release notes are missing');
    assert(!notes.includes('聊天加入'), 'English current release must use the English section');
  });
  await run('english-collapsed-badge-light', 'language=en&collapsed&automatic&available', async () => {
    await candidate().waitFor();
    assert((await version().getAttribute('aria-label')).includes('update v0.2.0 available'), 'Collapsed English update version must remain accessible');
    await version().click();
    await dialog().waitFor();
    assert((await dialog().innerText()).includes('Isolated acceptance: unify'), 'English candidate notes are missing');
    assert((await dialog().innerText()).includes('Update source: Automatic · GHProxy'), 'English update source summary is missing');
  }, { width: 900, height: 700 });
  return { scope: 'Real React App in Chromium with synthetic Tauri IO. No actual updater installs, services or GPU.', results, passed: results.every(result => result.passed) };
}
