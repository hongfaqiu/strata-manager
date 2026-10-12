// Runs against the existing isolated React/Tauri fixture. All saves stay in
// memory; no real model, service, credential or GPU setting is changed.
async page => {
  const origin = new URL(page.url()).origin;
  const errors = [], results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page.on('pageerror', error => errors.push(String(error)));
  for (const language of ['zh', 'en']) {
    const zh = language === 'zh';
    await page.setViewportSize({ width: 900, height: 760 });
    await page.goto(`${origin}/tuning-compact-app.html?language=${language}#config`);
    const port = page.getByRole('textbox', { name: zh ? 'API 端口' : 'API port', exact: true });
    const host = page.getByRole('combobox', { name: zh ? '监听地址' : 'Listen address', exact: true });
    const watts = page.getByRole('textbox', { name: zh ? 'GPU 功耗上限（W）' : 'GPU power limit (W)', exact: true });
    const device = page.getByRole('textbox', { name: zh ? '功耗设置 GPU 编号' : 'Power-limit GPU index', exact: true });
    const save = page.getByRole('button', { name: zh ? '保存完整配置' : 'Save full configuration', exact: true });
    const confirm = page.getByRole('button', { name: zh ? '确认保存' : 'Save changes', exact: true });
    await port.waitFor();
    const originalArgs = await page.evaluate(() => window.__fixture.configs.a.args);
    await port.fill('65536');
    await save.click();
    assert(await page.getByRole('alert').count() > 0, 'Invalid port must be explained');
    assert(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'write_config').length) === 0, 'Invalid port must never be saved');
    await port.fill('18099'); await host.fill('0.0.0.0'); await watts.fill('220.5'); await device.fill('0');
    await save.click(); await confirm.click();
    await page.waitForFunction(() => window.__fixture.configs.a.port === 18099);
    const saved = await page.evaluate(() => window.__fixture.configs.a);
    assert(saved.host === '0.0.0.0' && saved.manager_gpu_power_limit_watts === 220.5 && saved.manager_gpu_power_limit_device === 0, 'Network and power fields must share the saved JSON');
    assert(JSON.stringify(saved.args) === JSON.stringify(originalArgs), 'Unrelated engine arguments must be preserved');
    const addresses = await page.locator('.startup-service-addresses').innerText();
    assert(addresses.includes('18099/v1') && addresses.includes(zh ? '<本机局域网 IP>' : '<computer LAN IP>'), 'Wildcard binding must preview the LAN API address');
    const networkHelp = page.getByRole('button', { name: zh ? '网络访问帮助' : 'Network access help', exact: true });
    await networkHelp.click();
    const networkDialog = page.getByRole('dialog', { name: zh ? '网络访问帮助' : 'Network access help', exact: true });
    assert((await networkDialog.innerText()).includes('127.0.0.1:18099/v1'), 'Network help must retain the manager connection address');
    assert((await networkDialog.innerText()).includes('API Key') || (await networkDialog.innerText()).includes('API key'), 'Network help must explain the shared API key');
    await page.keyboard.press('Escape');
    await networkDialog.waitFor({ state: 'hidden' });
    assert(await networkHelp.evaluate(element => element === document.activeElement), 'Closing help must restore keyboard focus');
    await page.getByRole('button', { name: zh ? 'GPU 功耗帮助' : 'GPU power help', exact: true }).click();
    const powerDialog = page.getByRole('dialog', { name: zh ? 'GPU 功耗帮助' : 'GPU power help', exact: true });
    assert((await powerDialog.innerText()).includes(zh ? '所有程序' : 'all programs'), 'Power help must explain the GPU-wide effect');
    await page.keyboard.press('Escape');
    await powerDialog.waitFor({ state: 'hidden' });
    await page.getByRole('radio', { name: zh ? '完整 JSON' : 'Full JSON', exact: true }).click();
    const raw = await page.locator('#startup-full-config-json').inputValue();
    assert(JSON.parse(raw).manager_gpu_power_limit_watts === 220.5, 'JSON and graphical settings must agree');
    await page.getByRole('radio', { name: zh ? '图形界面' : 'Graphical', exact: true }).click();
    await watts.fill(''); await save.click(); await confirm.click();
    await page.waitForFunction(() => !Object.hasOwn(window.__fixture.configs.a, 'manager_gpu_power_limit_watts'));
    assert(await page.evaluate(() => window.__fixture.calls.filter(call => /^(start_service|restart_service|ensure_local_service|switch_local_service)$/.test(call.command)).length) === 0, 'Saving settings must not start or restart a service');
    const overflow = await page.evaluate(() => {
      const container = document.querySelector('.startup-network-power');
      return container.scrollWidth > container.clientWidth + 1;
    });
    assert(!overflow, 'Network/power controls must fit the narrow viewport');
    await page.locator('.startup-network-power').screenshot({ path: `output/playwright/network-power/narrow.${language}.png` });
    results.push({ language, passed: true, invalidPortRejected: true, savedWatts: 220.5, clearedPowerLimit: true, serviceMutations: 0, viewport: '900x760' });
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return { passed: true, scope: 'Real React UI, synthetic native saves, no hardware or service mutations', results };
}
