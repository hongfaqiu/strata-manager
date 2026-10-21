// Run via playwright-cli run-code --filename after opening the isolated fixture origin.
async page => {
  const origin = new URL(page.url()).origin, results = [], errors = [];
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const dialog = () => page.getByRole('dialog');
  const methods = () => dialog().getByRole('radiogroup', { name: /^(?:接入方式|Connection method)$/ });
  const lastCopy = () => page.evaluate(() => window.__fixture.copied.at(-1));
  async function choose(name, option) { await dialog().getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
  async function copyAndCheck(button, expected) { await button.click(); assert(await lastCopy() === expected, 'Copied payload differs from displayed configuration'); }
  async function run(name, query, action, viewport = { width: 1366, height: 900 }) {
    const errorStart = errors.length;
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/app-update-app.html?${query}#overview`);
      await page.locator('.overview-shortcut-api').waitFor();
      await page.locator('.boot').waitFor({ state: 'hidden' });
      await action();
      const forbidden = await page.evaluate(() => window.__fixture.calls.filter(call => /^(?:plugin:updater\|(?:download|install|download_and_install)|download_app_update|install_app_update|prepare_app_update|start_service|stop_service|restart_service|ensure_local_service|switch_local_service|take_over_service)$/.test(call.command) || call.command === 'strata_request' && call.args.method === 'POST'));
      assert(forbidden.length === 0, `Unexpected service/API/updater mutations: ${JSON.stringify(forbidden)}`);
      assert(errors.length === errorStart, `Browser errors: ${errors.slice(errorStart).join('; ')}`);
      await page.screenshot({ path: `output/playwright/app-updates/${name}.png`, fullPage: true });
      results.push({ name, passed: true, mutationCount: 0 });
    } catch (error) {
      await page.screenshot({ path: `output/playwright/app-updates/${name}-failure.png`, fullPage: true });
      results.push({ name, passed: false, error: String(error), browserErrors: errors.slice(errorStart) });
    }
  }
  await run('api-four-methods-copy-light', 'auth=none', async () => {
    const root = 'http://127.0.0.1:19001', model = 'Fixture A';
    await page.getByRole('button', { name: '接入 API', exact: true }).click();
    await dialog().waitFor();
    assert(await methods().getByRole('radio').count() === 6, 'All six integration methods must be shown');
    assert(await methods().getByRole('radio', { name: 'Cherry Studio', exact: true }).getAttribute('aria-checked') === 'true', 'Cherry Studio must be the default method');
    await copyAndCheck(dialog().getByRole('button', { name: '复制OpenAI 地址', exact: true }), `${root}/v1`);
    await copyAndCheck(dialog().getByRole('button', { name: '复制模型名', exact: true }), model);
    await copyAndCheck(dialog().getByRole('button', { name: '复制Cherry API 地址', exact: true }), root);
    assert((await dialog().innerText()).includes('无需密钥'), 'Verified keyless service should explain the placeholder');
    await page.screenshot({ path: 'output/playwright/app-updates/api-cherry-studio-light.png' });
    await methods().getByRole('radio', { name: '代码调用', exact: true }).click();
    for (const option of ['PowerShell', 'curl (Bash)', 'Python', 'JavaScript (Node.js)']) {
      await choose('代码语言', option);
      const pre = dialog().locator('.api-integration-code pre'), code = await pre.innerText();
      assert(code.includes(root) && code.includes(model), `${option} must use current service and model`);
      assert(code.includes('strata-local'), `${option} must use the verified keyless placeholder`);
      if (option === 'curl (Bash)') {
        const lines = code.split('\n').slice(1, -1);
        assert(lines.length === 3 && lines.every(line => /[^\\]\\$/.test(line)), 'Bash continuation must contain exactly one trailing backslash');
      }
      await copyAndCheck(dialog().locator('.api-integration-code').getByRole('button', { name: '复制', exact: true }), code);
    }
    await page.screenshot({ path: 'output/playwright/app-updates/api-javascript-light.png' });
    await methods().getByRole('radio', { name: 'OpenCode', exact: true }).click();
    const configText = await dialog().locator('pre[aria-label="opencode.json"]').innerText(), config = JSON.parse(configText);
    assert(config.provider.strata.options.baseURL === `${root}/v1`, 'OpenCode config has the wrong base URL');
    assert(config.provider.strata.models['local-model'].id === model, 'OpenCode config has the wrong model');
    await copyAndCheck(dialog().locator('.api-integration-code').first().getByRole('button', { name: '复制', exact: true }), configText);
    await choose('终端类型', 'Bash / zsh');
    const launch = await dialog().locator('pre[aria-label="终端命令"]').innerText();
    assert(launch.startsWith("export STRATA_API_KEY='strata-local'") && launch.endsWith('opencode'), 'OpenCode Bash launch command is invalid');
    await page.screenshot({ path: 'output/playwright/app-updates/api-opencode-light.png' });
    await methods().getByRole('radio', { name: 'Claude Code', exact: true }).click();
    await copyAndCheck(dialog().getByRole('button', { name: '复制Anthropic Base URL', exact: true }), root);
    const claude = await dialog().locator('pre[aria-label="配置并启动"]').innerText();
    assert(claude.includes(`ANTHROPIC_BASE_URL='${root}'`) && !claude.includes(`${root}/v1`), 'Claude must use the service root');
    assert(claude.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL='Fixture A'") && claude.endsWith('claude'), 'Claude background model and launch are missing');
    await copyAndCheck(dialog().locator('.api-integration-code').getByRole('button', { name: '复制', exact: true }), claude);
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '接入 API', exact: true }).click();
    await dialog().waitFor();
    assert(await methods().getByRole('radio', { name: 'Cherry Studio', exact: true }).getAttribute('aria-checked') === 'true', 'Reopened dialog should begin with the default method');
  });
  await run('api-stopped-service-preview', 'stopped', async () => {
    await page.waitForFunction(() => document.querySelector('#pill-text')?.textContent === '未启动');
    const entry = page.getByRole('button', { name: '接入 API', exact: true });
    assert(await entry.isEnabled(), 'Configured stopped service should still allow reading integration instructions');
    await entry.click();
    await dialog().waitFor();
    assert((await dialog().innerText()).includes('当前服务未连接'), 'Disconnected service needs an explicit status');
    assert(await dialog().getByRole('button', { name: '复制模型名', exact: true }).isDisabled(), 'Unknown stopped model must not be copied as a confirmed model ID');
    await methods().getByRole('radio', { name: '代码调用', exact: true }).click();
    assert(await dialog().locator('.api-integration-code').count() === 0, 'Stopped service without a confirmed model must not expose runnable examples');
    const requests = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'strata_request'));
    assert(requests.length === 0, 'Integration preview must not contact a stopped service');
  });
  await run('api-english-dark-small-window', 'language=en&theme=dark&auth=required', async () => {
    await page.getByRole('button', { name: 'Connect API', exact: true }).click();
    await dialog().waitFor();
    assert((await dialog().innerText()).includes('Replace YOUR_STRATA_API_KEY'), 'Keyed English service must use a service-key placeholder');
    await methods().getByRole('radio', { name: 'Code', exact: true }).click();
    await choose('Code language', 'Python');
    const python = await dialog().locator('.api-integration-code pre').innerText();
    assert(python.includes('YOUR_STRATA_API_KEY') && python.includes('base_url="http://127.0.0.1:19001/v1"'), 'English Python connection is incomplete');
    await methods().getByRole('radio', { name: 'Claude Code', exact: true }).click();
    const rect = await dialog().boundingBox();
    assert(rect && rect.x >= 0 && rect.x + rect.width <= 901 && rect.y >= 0 && rect.y + rect.height <= 701, 'Dialog must remain inside a small desktop viewport');
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'Small desktop window has horizontal overflow');
  }, { width: 900, height: 700 });
  return { scope: 'Real React App in Chromium. Native IO and clipboard are isolated fixtures. No real service, client requests or credentials.', results, passed: results.every(result => result.passed) };
}
