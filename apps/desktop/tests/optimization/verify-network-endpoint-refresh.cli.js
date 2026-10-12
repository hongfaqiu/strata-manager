// Uses the real App and React Query against in-memory native IO. These synthetic
// lifecycle handlers never launch a service or modify a real configuration.
async page => {
  const errors = [];
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${new URL(page.url()).origin}/tuning-compact-app.html?endpoint-refresh=${Date.now()}#config`);
  await page.getByRole('textbox', { name: 'API 端口', exact: true }).waitFor();
  await page.evaluate(async () => {
    const fixture = window.__fixture;
    fixture.profiles = structuredClone(fixture.profiles);
    const original = window.__TAURI_INTERNALS__.invoke;
    const statusOf = id => fixture.serviceStatuses[id] ?? { profileId: id, running: id === 'a', owned: id === 'a', pid: id === 'a' ? 99999 : null, phase: id === 'a' ? 'ready' : 'stopped' };
    const applyEndpoint = id => {
      const registered = fixture.profiles.find(item => item.id === id);
      const existing = new URL(registered.baseUrl);
      const config = fixture.configs[id];
      let host = config.host ?? existing.hostname;
      if (host === '0.0.0.0' || host === 'localhost') host = '127.0.0.1';
      if (host === '::') host = '[::1]';
      registered.baseUrl = `http://${host}:${config.port ?? Number(existing.port || 80)}`;
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const id = args.profileId ?? args.profile?.id ?? 'a';
      const record = () => fixture.calls.push({ command, args: structuredClone(args) });
      if (command === 'local_installations') { record(); return structuredClone(fixture.profiles); }
      if (command === 'service_status') { record(); return structuredClone(statusOf(id)); }
      if (command === 'write_config') {
        const result = await original(command, args);
        if (!statusOf(id).running) applyEndpoint(id);
        return result;
      }
      if (['restart_service', 'start_service', 'switch_local_service', 'ensure_local_service'].includes(command)) {
        record();
        if (command === 'restart_service' || !statusOf(id).running) applyEndpoint(id);
        fixture.serviceStatuses[id] = { profileId: id, running: true, owned: true, pid: 100001, phase: 'ready' };
        return structuredClone(fixture.serviceStatuses[id]);
      }
      if (command === 'stop_service') {
        record(); fixture.serviceStatuses[id] = { profileId: id, running: false, owned: false, pid: null, phase: 'stopped' };
        return structuredClone(fixture.serviceStatuses[id]);
      }
      return original(command, args);
    };
    await window.__query.invalidateQueries({ queryKey: ['setupRegistrations'] });
  });
  const port = () => page.getByRole('textbox', { name: 'API 端口', exact: true });
  const host = () => page.getByRole('combobox', { name: '监听地址', exact: true });
  const addresses = () => page.locator('.startup-service-addresses');
  const registryUrl = () => page.evaluate(() => window.__query.getQueryCache().findAll({ queryKey: ['setupRegistrations'] }).find(item => item.state.data)?.state.data?.find(item => item.id === 'a')?.baseUrl);
  const save = async restart => {
    await page.getByRole('button', { name: restart ? '保存并重启当前模型' : '保存完整配置', exact: true }).click();
    await page.getByRole('button', { name: '确认保存', exact: true }).click();
    await page.waitForFunction(() => window.__query.getQueryCache().findAll({ queryKey: ['startup-config'] }).every(item => item.state.fetchStatus !== 'fetching'));
  };
  assert(await port().inputValue() === '', 'Fixture must start with an absent port');
  assert((await addresses().innerText()).includes('19001/v1'), 'An absent port must preview the registered fallback, rather than 8080');
  await port().fill('18099'); await host().fill('0.0.0.0'); await save(false);
  await page.waitForFunction(() => window.__fixture.configs.a.port === 18099);
  assert(await registryUrl() === 'http://127.0.0.1:19001', 'A running save must retain the live registry endpoint');
  assert(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'restart_service').length) === 0, 'Saving must not restart the running service');
  await port().fill('18100'); await save(true);
  await page.waitForFunction(() => window.__query.getQueryCache().findAll({ queryKey: ['setupRegistrations'] }).some(item => item.state.data?.some(profile => profile.id === 'a' && profile.baseUrl.endsWith(':18100'))));
  assert(await port().getAttribute('placeholder') === '留空保留 18100', 'The React profile must refresh after restart, including its fallback preview');
  await port().fill(''); await host().fill('');
  assert((await addresses().innerText()).includes('18100/v1'), 'Clearing network overrides must retain the current endpoint');
  await save(false);
  await page.waitForFunction(() => !Object.hasOwn(window.__fixture.configs.a, 'port'));
  assert(await registryUrl() === 'http://127.0.0.1:18100', 'Deleting port must use the same fallback in UI and runtime');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.getByRole('button', { name: '停止服务', exact: true }).click();
  await page.waitForFunction(() => window.__fixture.serviceStatuses.a?.running === false);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '运行配置', exact: true }).first().click();
  await port().fill('18101'); await host().fill('127.0.0.1'); await save(false);
  await page.waitForFunction(() => window.__query.getQueryCache().findAll({ queryKey: ['setupRegistrations'] }).some(item => item.state.data?.some(profile => profile.id === 'a' && profile.baseUrl.endsWith(':18101'))));
  assert(await port().getAttribute('placeholder') === '留空保留 18101', 'Saving a stopped service must refresh the React profile immediately');
  assert(await page.evaluate(() => window.__fixture.serviceStatuses.a.running) === false, 'Saving a stopped service must leave it stopped');
  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.getByRole('button', { name: '启动服务', exact: true }).click();
  await page.waitForFunction(() => window.__fixture.serviceStatuses.a?.running === true);
  assert(await registryUrl() === 'http://127.0.0.1:18101', 'Starting must retain the updated endpoint in React Query');
  assert(errors.length === 0, `Unexpected browser errors: ${errors.join('; ')}`);
  return { passed: true, absentPortFallback: 19001, runningSavePreserved: 19001, restartRefreshed: 18100, clearedPortFallback: 18100, stoppedSaveRefreshed: 18101, startRefreshed: 18101, scope: 'Real App and React Query, in-memory synthetic lifecycle only' };
}
