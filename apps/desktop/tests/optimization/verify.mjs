import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// Reuses installed tools. Supply an existing Playwright module/executable when
// they are outside node_modules; this script never installs or downloads them.
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
const results = [], errors = [];
const output = resolve(root, 'output/optimization-verification');
await mkdir(output, { recursive: true });
async function run(name, route, action) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', request => new URL(request.request().url()).origin === origin ? request.continue() : request.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  try {
    await page.goto(`${origin}/${route}`);
    await page.waitForSelector('#view-config, .service-manager-card, #view-chat, .overview-service, #view-monitor, #view-about, .tuning-page, .settings-layout', { timeout: 20000 });
    await action(page);
    assert.deepEqual(pageErrors, []);
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), pageErrors }); errors.push(error);
    console.log(`FAIL ${name}: ${error}`);
    await page.screenshot({ path: resolve(output, `${results.length}-failure.png`) });
    await writeFile(resolve(output, `${results.length}-failure.txt`), await page.locator('body').innerText());
  } finally { await context.close(); }
}
const rawEditor = page => page.getByRole('textbox', { name: '完整本地 JSON 配置', exact: true });
async function editJson(page) {
  await page.getByRole('radio', { name: '完整 JSON', exact: true }).click();
  const editor = rawEditor(page); await editor.waitFor();
  await editor.fill(JSON.stringify({ exe: 'fixture/python.exe', cwd: 'fixture/a', args: ['--model', 'fixture/a.gguf', '--pool-workers', '8'], model_name: 'Fixture A' }, null, 2));
  return editor;
}
const decision = page => page.getByRole('dialog', { name: '有未保存的改动' });
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  await run('noncurrent logs preserve the active model and call no lifecycle RPC', '#models', async page => {
    const card = page.locator('[data-profile-id="b"]');
    await card.getByRole('button', { name: '详情与管理', exact: true }).click();
    await card.getByRole('button', { name: '查看日志', exact: true }).click();
    await page.getByText('logs for b', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__fixture.store.activeProfile), 'a');
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => /^(switch_local_service|ensure_local_service|start_service|stop_service|restart_service)$/.test(call.command)).length), 0);
  });
  await run('cancel navigation and reload preserve the JSON draft without reads', '#config', async page => {
    const editor = await editJson(page), value = await editor.inputValue();
    await page.locator('.model-config-breadcrumb > button').click();
    await decision(page).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor.inputValue(), value); assert.match(page.url(), /#config$/);
    const before = await page.evaluate(() => window.__fixture.calls.filter(call => call.command.startsWith('read_config')).length);
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await decision(page).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor.inputValue(), value);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command.startsWith('read_config')).length), before);
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await decision(page).getByRole('button', { name: '保存并继续', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.configs.a.args.includes('8'));
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'restart_service').length), 0);
    assert.match(await editor.inputValue(), /"8"/);
  });
  await run('clean Back and Forward preserve three accepted history entries', '#models', async page => {
    await page.getByRole('button', { name: '运行配置', exact: true }).first().click();
    await page.waitForURL('**/#config');
    await page.locator('.model-config-breadcrumb > button').click();
    await page.waitForURL('**/#models');
    await page.goBack(); await page.waitForURL('**/#config'); await rawEditor(page).count();
    await page.goBack(); await page.waitForURL('**/#models');
    await page.goForward(); await page.waitForURL('**/#config');
  });
  await run('dirty history cancel preserves entry and discard replays Back once', '#models', async page => {
    await page.getByRole('button', { name: '运行配置', exact: true }).first().click(); await page.waitForURL('**/#config');
    const editor = await editJson(page), value = await editor.inputValue();
    const length = await page.evaluate(() => history.length);
    await page.goBack(); await decision(page).waitFor(); await page.waitForURL('**/#config');
    await decision(page).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor.inputValue(), value); assert.equal(await page.evaluate(() => history.length), length);
    await page.goBack(); await decision(page).getByRole('button', { name: '放弃改动', exact: true }).click();
    await page.waitForURL('**/#models'); assert.equal(await page.evaluate(() => history.length), length);
    await page.goForward(); await page.waitForURL('**/#config');
  });
  await run('model startup draft protects navigation and exit has only one modal', '#config', async page => {
    const editor = await editJson(page), draft = await editor.inputValue();
    await page.locator('.model-config-breadcrumb > button').click();
    await decision(page).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor.inputValue(), draft);
    await page.evaluate(() => window.__fixture.emit());
    await page.getByRole('dialog').getByRole('button', { name: '停止服务并退出', exact: true }).click();
    await decision(page).waitFor(); assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await editor.inputValue(), draft);
    assert.equal(await page.evaluate(() => document.getElementById('root').inert), false);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'confirm_window_close').length), 0);
  });
  await run('external clean hash entries support dirty Back without guessing its direction', '#overview', async page => {
    await page.evaluate(() => { location.hash = 'models'; }); await page.locator('.service-manager-card').first().waitFor();
    assert.equal(await page.evaluate(() => Number.isSafeInteger(history.state?.strataNavigationIndex)), true);
    await page.getByRole('button', { name: '运行配置', exact: true }).first().click(); await page.waitForURL('**/#config');
    const editor = await editJson(page), value = await editor.inputValue();
    await page.goBack(); await decision(page).waitFor(); await page.waitForURL('**/#config');
    await decision(page).getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await editor.inputValue(), value);
    await page.goBack(); await decision(page).getByRole('button', { name: '放弃改动', exact: true }).click(); await page.waitForURL('**/#models');
  });
  await run('unindexed external hash navigation preserves a dirty draft until approved', '#config', async page => {
    const editor = await editJson(page), value = await editor.inputValue();
    await page.evaluate(() => { location.hash = 'models'; }); await decision(page).waitFor(); await page.waitForURL('**/#config');
    await decision(page).getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await editor.inputValue(), value);
    await page.evaluate(() => { location.hash = 'models'; }); await decision(page).getByRole('button', { name: '放弃改动', exact: true }).click(); await page.waitForURL('**/#models');
  });
  await run('read failure preserves the existing draft', '#config', async page => {
    const editor = await editJson(page), value = await editor.inputValue();
    await page.evaluate(() => { window.__fixture.failReads = true; });
    await page.getByRole('button', { name: '重新读取', exact: true }).click(); await decision(page).getByRole('button', { name: '放弃改动', exact: true }).click();
    await page.getByText('Fixture read failed', { exact: false }).first().waitFor(); assert.equal(await editor.inputValue(), value);
  });
  await run('failed configuration application remains visible after its confirmation closes', '#config', async page => {
    await page.getByRole('button', { name: '展开此模型的配置列表', exact: true }).click();
    await page.locator('.configuration-list-row').first().hover();
    await page.getByRole('button', { name: '重启模型服务并应用配置 a.json', exact: true }).click();
    await page.getByRole('dialog', { name: '应用运行配置' }).getByRole('button', { name: '使用并重启', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Forbidden fixture lifecycle: restart_service' }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
  });
  await run('copying a configuration protects its startup draft before changing identity', '#config', async page => {
    const editor = await editJson(page), draft = await editor.inputValue();
    const copy = async () => {
      await page.getByRole('button', { name: '复制为新配置', exact: true }).click();
      await page.getByRole('dialog', { name: '复制为新配置' }).getByRole('button', { name: '创建副本', exact: true }).click();
      await decision(page).waitFor(); assert.equal(await page.getByRole('dialog').count(), 1);
    };
    await copy();
    await decision(page).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await editor.inputValue(), draft);
    assert.equal(await page.evaluate(() => window.__fixture.configs.a.args.includes('8')), false, 'The original configuration is unchanged while its startup draft remains unsaved');
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command.startsWith('read_config')).at(-1).args.profile.id), 'a');
    await copy(); await decision(page).getByRole('button', { name: '放弃改动', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command.startsWith('read_config') && call.args.profile.id.startsWith('copy-')));
    await page.getByRole('radio', { name: '完整 JSON', exact: true }).click();
    await rawEditor(page).waitFor();
    const copied = await page.evaluate(() => window.__fixture.calls.filter(call => call.command.startsWith('read_config')).at(-1).args.profile.id);
    assert.deepEqual(JSON.parse(await rawEditor(page).inputValue()), await page.evaluate(id => window.__fixture.configs[id], copied), 'Selecting the copy loads its saved startup configuration');
    assert.equal(await page.getByRole('button', { name: '保存完整配置', exact: true }).isDisabled(), true, 'The copied startup settings are a saved baseline, not an unsaved draft');
    assert.equal(await page.evaluate(() => window.__fixture.configs.a.args.includes('8')), false);
  });
  await run('successful write followed by failed reload preserves saved content', '#config', async page => {
    const editor = await editJson(page);
    await page.evaluate(() => { window.__fixture.failAfterWrite = true; });
    await page.getByRole('button', { name: '保存完整配置', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click();
    await page.getByText('文件已保存，但重新读取失败', { exact: false }).first().waitFor();
    assert.match(await editor.inputValue(), /"8"/);
    assert.equal(await page.evaluate(() => window.__fixture.configs.a.args.includes('8')), true);
    await page.evaluate(() => { window.__fixture.failAfterWrite = false; });
    await editor.fill((await editor.inputValue()).replace('"8"', '"12"'));
    await page.getByRole('button', { name: '保存完整配置', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.configs.a.args.includes('12'));
    const writes = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'write_config'));
    assert.equal(writes.length, 2); assert.match(writes[1].args.expectedRevision, /"8"/);
  });
  await run('configuration CAS conflict preserves draft and never restarts', '#config', async page => {
    const editor = await editJson(page), draft = await editor.inputValue();
    await page.evaluate(() => { window.__fixture.configs.a.args[window.__fixture.configs.a.args.indexOf('4')] = '6'; });
    await page.getByRole('button', { name: '保存完整配置', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认保存', exact: true }).click();
    await page.getByText('CONFIG_REVISION_CONFLICT', { exact: false }).first().waitFor();
    assert.equal(await editor.inputValue(), draft);
    assert.equal(await page.evaluate(() => window.__fixture.configs.a.args.includes('6')), true);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => /restart_service|start_service/.test(call.command)).length), 0);
  });
  await run('sidebar preference changes persist only their own key', '#overview', async page => {
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set'));
    await page.evaluate(() => { window.__fixture.calls.length = 0; });
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set' && call.args.key === 'sidebarCollapsed'));
    const keys = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'store_set').map(call => call.args.key));
    assert.deepEqual(keys, ['sidebarCollapsed']);
  });
  await run('exit waits for an in-flight store checkpoint before closing', '#overview', async page => {
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set'));
    await page.evaluate(() => { window.__fixture.calls.length = 0; window.__fixture.holdStore = true; });
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await page.waitForFunction(() => !!window.__fixture.releaseStore);
    await page.evaluate(() => window.__fixture.emit());
    await page.getByRole('dialog').getByRole('button', { name: '停止服务并退出', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'confirm_window_close').length), 0);
    await page.evaluate(() => window.__fixture.releaseStore());
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'confirm_window_close'));
    assert.equal(await page.evaluate(() => window.__fixture.store.sidebarCollapsed), true);
  });
  await run('failed final persistence prevents exit and can be retried', '#overview', async page => {
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set'));
    await page.evaluate(() => { window.__fixture.failStoreWrites = true; });
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    const failures = await page.evaluate(() => window.__fixture.storeFailures ?? 0);
    await page.evaluate(() => window.__fixture.emit());
    await page.getByRole('dialog').getByRole('button', { name: '停止服务并退出', exact: true }).click();
    await page.getByText('Fixture disk write failed', { exact: false }).first().waitFor();
    await page.waitForFunction(previous => {
      const button = document.querySelector('[role="dialog"] button.danger-solid');
      return window.__fixture.storeFailures > previous && button?.textContent.includes('停止服务并退出') && !button.disabled;
    }, failures);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'confirm_window_close').length), 0);
    await page.evaluate(() => { window.__fixture.failStoreWrites = false; });
    await page.getByRole('dialog').getByRole('button', { name: '停止服务并退出', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'confirm_window_close'));
    assert.equal(await page.evaluate(() => window.__fixture.store.sidebarCollapsed), true);
  });
  await run('remote clean refresh follows server and dirty refresh preserves edit', '?remote#config', async page => {
    const field = page.getByRole('spinbutton', { name: '空闲卸载时间（秒）', exact: true }); await field.waitFor();
    assert.equal(await page.locator('.runtime-config-field details, .runtime-config-sampling details').count(), 0);
    assert.ok(await field.getAttribute('aria-describedby'));
    await page.waitForFunction(() => document.querySelector('[data-testid="dirty"]').textContent === 'false');
    await page.evaluate(async () => { window.__fixture.remoteValue = 200; await window.__query.invalidateQueries({ queryKey: ['official-config'] }); });
    await page.waitForFunction(() => document.getElementById('cfg-0').value === '200');
    assert.equal(await field.inputValue(), '200'); assert.equal(await page.getByTestId('dirty').innerText(), 'false');
    await field.fill('300');
    await page.evaluate(async () => { window.__fixture.remoteValue = 400; await window.__query.invalidateQueries({ queryKey: ['official-config'] }); });
    await page.waitForFunction(() => document.querySelector('[data-testid="dirty"]').textContent === 'true');
    assert.equal(await field.inputValue(), '300'); assert.equal(await page.getByTestId('dirty').innerText(), 'true');
    await page.getByRole('button', { name: '重新读取', exact: true }).click(); await decision(page).getByRole('button', { name: '取消', exact: true }).click(); assert.equal(await field.inputValue(), '300');
  });
  await run('partial answer remains visible with interruption error', '#chat', async page => {
    await page.getByText('已收到的部分回答', { exact: true }).waitFor();
    await page.getByText('STREAM_INCOMPLETE', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '复制回答', exact: true }).count(), 1);
  });
  await run('memoized historical answers still respond to language context changes', '#chat', async page => {
    await page.getByRole('button', { name: '复制回答', exact: true }).waitFor();
    await page.evaluate(() => window.__i18n.changeLanguage('en'));
    await page.getByRole('button', { name: 'Copy answer', exact: true }).waitFor();
    assert.equal(await page.getByText('已收到的部分回答', { exact: true }).count(), 1);
  });
  await run('old supervisor disables full scenario without tuning mutation', '#tuning', async page => {
    await page.getByText('当前后台不支持完整场景实测。', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '开始实测', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'tuning_start').length), 0);
  });
  await run('settings help supports keyboard access without extra disclosure rows or preference changes', '#settings', async page => {
    const help = page.getByRole('button', { name: '本机后台帮助', exact: true });
    await help.waitFor();
    assert.equal(await page.locator('.settings-layout details').count(), 0);
    const previous = await page.evaluate(() => JSON.stringify(window.__fixture.store));
    await page.screenshot({ path: resolve(output, 'settings-simplified.png') });
    await help.focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '本机后台', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await help.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__fixture.store)), previous);
  });
  await run('tuning help preserves model state and keeps one advanced control group', '#tuning', async page => {
    const help = page.getByRole('button', { name: '调优测试帮助', exact: true }); await help.waitFor();
    assert.equal(await page.locator('.tuning-page details.tuning-setup-disclosure').count(), 1);
    assert.equal(await page.locator('.tuning-page details.tuning-advanced').count(), 1);
    assert.equal(await page.locator('.tuning-advanced details').count(), 0);
    await page.getByText('测试占用当前模型，完成后恢复原配置。', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, 'tuning-simplified.png') });
    const before = await page.evaluate(() => window.__fixture.calls.length);
    await help.focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '调优测试说明', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await help.evaluate(element => element === document.activeElement), true);
    const calls = await page.evaluate(index => window.__fixture.calls.slice(index), before);
    assert.equal(calls.filter(call => /^(tuning_start|start_service|stop_service|restart_service)$/.test(call.command)).length, 0);
  });
  await run('missing engine version and image capability remain explicitly unknown', '#about', async page => {
    await page.getByText('未报告版本', { exact: true }).waitFor();
    await page.getByText('未知', { exact: true }).waitFor();
    assert.equal(await page.getByText('从源码构建', { exact: true }).count(), 0);
  });
  await run('telemetry failure marks cached values as stale and removes live progress', '#monitor', async page => {
    await page.getByText('上次成功采样', { exact: false }).waitFor();
    await page.evaluate(async () => { window.__fixture.metricFailure = true; await window.__query.invalidateQueries({ queryKey: ['metrics'] }); });
    await page.getByText('下方数值为上次采样', { exact: false }).waitFor();
    assert.equal(await page.locator('#state-label').innerText(), '实时状态未核验');
    assert.equal(await page.locator('#state-bar').evaluate(element => element.style.width), '0%');
  });
} finally {
  await writeFile(resolve(output, 'browser-results.json'), JSON.stringify(results, null, 2));
  await browser?.close(); await server.close();
}
if (errors.length) throw new AggregateError(errors, `${errors.length} isolated browser regressions failed`);
