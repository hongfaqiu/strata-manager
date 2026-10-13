import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Uses the complete App and its existing synthetic native fixture. No real
// Supervisor, model, credentials or non-loopback request is available to tests.
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const output = resolve(root, 'output/playwright/common-settings');
await mkdir(output, { recursive: true });
const results = [];
let browser;

async function initializeFixture(context, scenario = {}) {
  await context.addInitScript(({ storeSeed = {}, emptyModels = false, credentialProfiles = [] }) => {
    const persistenceKey = 'strata-common-settings-test-store';
    let currentFixture;
    let nativeInternals;
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(persistenceKey) || '{}'); } catch {}
    Object.defineProperty(window, '__fixture', {
      configurable: true,
      get: () => currentFixture,
      set: fixture => {
        currentFixture = fixture;
        Object.assign(fixture.store, storeSeed, saved);
        fixture.credentialProfiles = new Set(credentialProfiles);
        if (emptyModels) {
          fixture.profiles.length = 0;
          fixture.store.activeProfile = '';
          fixture.supervisor = { pid: 88888, activeServices: 0, activeLocalInstallation: null, localServiceDesired: false, health: {} };
        }
      },
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      get: () => nativeInternals,
      set: internals => {
        nativeInternals = internals;
        const original = internals.invoke;
        internals.invoke = async (command, args = {}) => {
          const fixture = currentFixture;
          if (command === 'has_api_key') {
            fixture.calls.push({ command, args: structuredClone(args) });
            return fixture.credentialProfiles.has(args.profileId);
          }
          if (command === 'set_api_key') {
            fixture.calls.push({ command, args: structuredClone(args) });
            if (args.apiKey) fixture.credentialProfiles.add(args.profileId);
            else fixture.credentialProfiles.delete(args.profileId);
            return;
          }
          const result = await original.call(internals, command, args);
          if (command === 'store_set') sessionStorage.setItem(persistenceKey, JSON.stringify(fixture.store));
          return result;
        };
      },
    });
  }, scenario);
}

async function choose(page, name, option) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function useFixtureModel(page, id) {
  await page.evaluate(async id => {
    const fixture = window.__fixture;
    Object.assign(fixture.supervisor, { pid: 88888, activeLocalInstallation: id, localServiceDesired: true, activeServices: 1 });
    fixture.supervisor.health = { [id]: { phase: 'healthy', apiHealthy: true, loaded: true, pid: id === 'a' ? 99999 : 99998, checkedAt: Date.now(), lastHealthyAt: Date.now(), reason: '', failures: [], observerState: 'idle' } };
    for (const profile of fixture.profiles) fixture.serviceStatuses[profile.id] = { profileId: profile.id, running: profile.id === id, owned: profile.id === id, pid: profile.id === id ? (id === 'a' ? 99999 : 99998) : null, phase: profile.id === id ? 'ready' : 'stopped' };
    await window.__query.invalidateQueries({ queryKey: ['supervisor'] });
  }, id);
  await page.waitForFunction(id => window.__fixture.store.activeProfile === id, id);
}

async function navigate(page, route) {
  await page.evaluate(route => { location.hash = route; }, route);
  await page.waitForURL(url => url.hash === `#${route}`);
}
async function commonPanel(page) {
  await page.locator('.common-chat-settings-panel').waitFor();
}
async function commonValue(page, key, value) {
  await page.waitForFunction(({ key, value }) => window.__fixture.store.commonChatDefaults?.[key] === value, { key, value });
}
async function sendChat(page, id, expectedTemperature, expectedMaxTokens) {
  await navigate(page, 'chat');
  await page.locator('#input').waitFor();
  const before = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'strata_stream').length);
  await page.locator('#input').fill(`common-settings-fixture-${id}-${before}`);
  await page.locator('#send-btn').click();
  await page.waitForFunction(before => window.__fixture.calls.filter(call => call.command === 'strata_stream').length > before, before);
  const sent = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'strata_stream').at(-1).args);
  assert.equal(sent.profile.id, id);
  assert.equal(sent.body.temperature, expectedTemperature);
  if (expectedMaxTokens !== undefined) assert.equal(sent.body.max_tokens, expectedMaxTokens);
  await page.waitForFunction(() => !document.getElementById('input').disabled && document.getElementById('stop-btn').hidden);
  return sent.body;
}

const legacyA = {
  model: 'Fixture A', reasoningEffort: 'low', temperature: 0.25, topP: 0.8, topK: 7,
  maxTokens: 128, seed: 19, systemPrompt: 'legacy-model-A-prompt', mcp: false,
  experimentalSpeedProjection: false,
};
const sharedSeed = {
  reasoningEffort: 'high', temperature: 0.9, topP: 0.95, topK: 20,
  maxTokens: 96, seed: null, systemPrompt: 'shared-chat-fixture', mcp: true,
};

async function run(name, route, scenario, action) {
  if (process.env.STRATA_COMMON_SETTINGS_CASE && process.env.STRATA_COMMON_SETTINGS_CASE !== name) return;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await initializeFixture(context, scenario);
  const page = await context.newPage();
  const pageErrors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(String(error)));
  try {
    await page.goto(`${origin}/official-app.html#${route}`);
    if (route === 'chat') await page.locator('#sampling-btn').waitFor();
    else await page.locator('.management-content').filter({ visible: true }).first().waitFor();
    const evidence = await action(page);
    assert.deepEqual(pageErrors, []);
    const forbidden = await page.evaluate(() => window.__fixture.calls.filter(call => /^(?:switch_local_service|ensure_local_service|start_service|stop_service|restart_service|take_over_service|run_setup|install_runtime|update_runtime|write_config)$/.test(call.command)));
    assert.deepEqual(forbidden, [], 'Common settings must not mutate native model services or configuration files');
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    results.push({ name, passed: true, ...(evidence ? { evidence } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ url: location.href, rootInert: document.getElementById('root')?.inert, rootAriaHidden: document.getElementById('root')?.getAttribute('aria-hidden'), input: document.getElementById('input')?.value, sendDisabled: document.getElementById('send-btn')?.disabled, activeProfile: window.__fixture.store.activeProfile, dialogs: [...document.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent), chatStreams: window.__fixture.calls.filter(call => call.command === 'strata_stream').map(call => ({ profileId: call.args.profile.id, temperature: call.args.body.temperature })) }));
    results.push({ name, passed: false, error: String(error), pageErrors, diagnostic });
    console.log(`FAIL ${name}: ${error}`);
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    await writeFile(resolve(output, `${name}-failure.txt`), await page.locator('body').innerText());
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  await run('common-entry-and-model-config-separation', 'settings', {}, async page => {
    const nav = page.locator('.workspace-subnav');
    const selectedSettingsRoute = async (route, tab) => {
      await page.waitForURL(url => url.hash === `#${route}`);
      await page.locator(`.management-content--${route}`).waitFor();
      assert.equal(await nav.getByRole('button', { name: tab, exact: true }).getAttribute('aria-current'), 'page');
      const sidebarSettings = page.locator('#manager-navigation').getByRole('button', { name: '设置', exact: true });
      assert.equal(await sidebarSettings.getAttribute('aria-current'), 'page');
      assert.equal(await sidebarSettings.evaluate(element => element.classList.contains('active')), true);
    };
    await selectedSettingsRoute('settings', '公共设置');
    assert.equal(await page.locator('#settings-floating-monitor, .common-chat-settings-panel').count(), 0);
    assert.equal(await page.getByRole('combobox', { name: '监控刷新间隔', exact: true }).count(), 0);
    await nav.getByRole('button', { name: '桌面监控', exact: true }).click();
    await selectedSettingsRoute('monitor-settings', '桌面监控');
    await page.locator('#settings-floating-monitor').waitFor();
    assert.equal(await page.getByRole('combobox', { name: '监控刷新间隔', exact: true }).count(), 1);
    assert.equal(await page.locator('.common-chat-settings-panel').count(), 0);
    await nav.getByRole('button', { name: '聊天默认', exact: true }).click();
    await selectedSettingsRoute('chat-defaults', '聊天默认'); await commonPanel(page);
    assert.equal(await page.locator('#settings-floating-monitor').count(), 0);
    assert.equal(await page.getByRole('combobox', { name: '监控刷新间隔', exact: true }).count(), 0);
    await page.goBack(); await selectedSettingsRoute('monitor-settings', '桌面监控');
    await page.reload(); await selectedSettingsRoute('monitor-settings', '桌面监控');
    await page.locator('#settings-floating-monitor').waitFor();
    await page.goForward(); await selectedSettingsRoute('chat-defaults', '聊天默认');
    await page.reload(); await selectedSettingsRoute('chat-defaults', '聊天默认'); await commonPanel(page);
    await nav.getByRole('button', { name: 'API 与外部助手', exact: true }).click();
    await page.waitForURL(url => url.hash === '#connections');
    await page.locator('.service-connection-panel').waitFor();
    assert.equal(await page.locator('.mcp-integration-panel').count(), 1);
    await nav.getByRole('button', { name: '显存与会话', exact: true }).click();
    await page.waitForURL(url => url.hash === '#runtime-tools');
    await page.locator('.runtime-operations').waitFor();
    await navigate(page, 'config');
    await page.locator('#view-config').waitFor();
    assert.equal(await page.locator('.mcp-integration-panel, .service-connection-panel, .runtime-operations').count(), 0);
    assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).count(), 0);
    await navigate(page, 'chat-defaults'); await commonPanel(page);
  });
  await run('common-defaults-editable-with-no-model', 'chat-defaults', { emptyModels: true }, async page => {
    await commonPanel(page);
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).isDisabled(), true);
    const temperature = page.getByRole('spinbutton', { name: '公共默认温度', exact: true });
    assert.equal(await temperature.isDisabled(), false);
    await temperature.fill('0.85');
    await page.getByRole('spinbutton', { name: '公共默认最大输出 token', exact: true }).fill('768');
    await page.getByRole('textbox', { name: '公共默认系统提示词', exact: true }).fill('no-model-shared-prompt');
    await commonValue(page, 'temperature', 0.85); await commonValue(page, 'maxTokens', 768); await commonValue(page, 'systemPrompt', 'no-model-shared-prompt');
    assert.equal(await page.evaluate(() => window.__fixture.profiles.length), 0);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'manager_mcp_connection').length), 0);
  });
  await run('two-models-inherit-and-send-common-defaults', 'chat-defaults', { storeSeed: { commonChatDefaults: sharedSeed } }, async page => {
    await commonPanel(page);
    await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).fill('0.8');
    await commonValue(page, 'temperature', 0.8);
    await useFixtureModel(page, 'a');
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'true');
    const a = await sendChat(page, 'a', 0.8, 96);
    assert.ok(a.messages.some(message => message.role === 'system' && message.content === sharedSeed.systemPrompt));
    await navigate(page, 'chat-defaults'); await commonPanel(page);
    await useFixtureModel(page, 'b');
    assert.equal(await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).inputValue(), '0.8');
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'true');
    await sendChat(page, 'b', 0.8, 96);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.commonChatDefaults), { ...sharedSeed, temperature: 0.8 });
  });
  await run('legacy-model-overrides-remain-independent', 'chat-defaults', { storeSeed: { commonChatDefaults: sharedSeed, chatOptionsByProfile: { a: legacyA } } }, async page => {
    await commonPanel(page);
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'false');
    await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).fill('0.95'); await commonValue(page, 'temperature', 0.95);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA);
    const sent = await sendChat(page, 'a', legacyA.temperature, legacyA.maxTokens);
    assert.equal(sent.top_p, legacyA.topP); assert.equal(sent.top_k, legacyA.topK); assert.equal(sent.seed, legacyA.seed);
    assert.ok(sent.messages.some(message => message.role === 'system' && message.content === legacyA.systemPrompt));
    await navigate(page, 'chat-defaults'); await commonPanel(page); await useFixtureModel(page, 'b');
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'true');
    await sendChat(page, 'b', 0.95, sharedSeed.maxTokens);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA);
  });
  await run('explicit-inheritance-and-model-specific-sampling', 'chat-defaults', { storeSeed: { commonChatDefaults: sharedSeed, chatOptionsByProfile: { a: legacyA } } }, async page => {
    await commonPanel(page);
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === true);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA);
    await sendChat(page, 'a', sharedSeed.temperature, sharedSeed.maxTokens);
    await navigate(page, 'chat-defaults'); await commonPanel(page);
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === false);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA, 'Disabling inheritance must restore the existing dedicated values');
    await sendChat(page, 'a', legacyA.temperature, legacyA.maxTokens);
    await navigate(page, 'chat-defaults'); await commonPanel(page);
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === true);
    await sendChat(page, 'a', sharedSeed.temperature, sharedSeed.maxTokens);
    await page.locator('#sampling-btn').click();
    await page.locator('#s-temp').press('End');
    await page.locator('#s-apply').click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === false);
    await sendChat(page, 'a', 1.5, sharedSeed.maxTokens);
    await navigate(page, 'chat-defaults'); await commonPanel(page);
    assert.equal(await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).inputValue(), String(sharedSeed.temperature));
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'false');
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === true);
    await sendChat(page, 'a', sharedSeed.temperature, sharedSeed.maxTokens);
  });
  await run('sampling-drawer-switch-keeps-drafts-bound-to-model', 'chat', { storeSeed: { commonChatDefaults: sharedSeed, chatOptionsByProfile: { a: legacyA } } }, async page => {
    await page.locator('#sampling-btn').click();
    await page.locator('#s-temp').press('End');
    assert.equal(await page.locator('#s-temp').inputValue(), '1.5');
    await useFixtureModel(page, 'b');
    await page.waitForFunction(() => document.querySelector('.common-chat-drawer-scope')?.textContent.includes('Fixture B') && document.getElementById('s-temp')?.value === '0.9');
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA);
    await page.locator('#s-temp').press('End');
    await page.locator('#s-apply').click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.b === false);
    await sendChat(page, 'b', 1.5, sharedSeed.maxTokens);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.commonChatDefaults), sharedSeed);
    await useFixtureModel(page, 'a'); await sendChat(page, 'a', legacyA.temperature, legacyA.maxTokens);
  });
  await run('advanced-only-edit-preserves-dedicated-defaults-during-inheritance', 'chat-defaults', { storeSeed: { commonChatDefaults: sharedSeed, chatOptionsByProfile: { a: legacyA } } }, async page => {
    await commonPanel(page);
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === true);
    await sendChat(page, 'a', sharedSeed.temperature, sharedSeed.maxTokens);
    await page.locator('#sampling-btn').click();
    assert.equal(await page.locator('#s-temp').inputValue(), String(sharedSeed.temperature));
    assert.equal(await page.locator('#s-max').inputValue(), String(sharedSeed.maxTokens));
    assert.equal(await page.locator('#s-system').inputValue(), sharedSeed.systemPrompt);
    await page.getByRole('button', { name: '调整生成参数', exact: true }).click();
    await page.locator('#chat-minP').fill('0.17');
    await page.locator('#s-apply').click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__fixture.store.chatOptionsByProfile.a.advanced?.minP === 0.17 && window.__fixture.store.chatDefaultsInheritance.a === true);
    const saved = await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a);
    const commonKeys = Object.keys(sharedSeed);
    const dedicated = Object.fromEntries(commonKeys.map(key => [key, saved[key]]));
    assert.deepEqual(dedicated, Object.fromEntries(commonKeys.map(key => [key, legacyA[key]])), 'An advanced-only edit must preserve all eight dedicated defaults');
    const inherited = await sendChat(page, 'a', sharedSeed.temperature, sharedSeed.maxTokens);
    assert.equal(inherited.min_p, 0.17);
    assert.ok(inherited.messages.some(message => message.role === 'system' && message.content === sharedSeed.systemPrompt));
    await navigate(page, 'chat-defaults'); await commonPanel(page);
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'true');
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === false);
    const restored = await sendChat(page, 'a', legacyA.temperature, legacyA.maxTokens);
    assert.equal(restored.top_p, legacyA.topP); assert.equal(restored.top_k, legacyA.topK); assert.equal(restored.seed, legacyA.seed);
    assert.equal(restored.min_p, 0.17, 'The advanced model setting must survive disabling common inheritance');
    assert.ok(restored.messages.some(message => message.role === 'system' && message.content === legacyA.systemPrompt));
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.commonChatDefaults), sharedSeed);
    const requestEvidence = body => ({ temperature: body.temperature, maxTokens: body.max_tokens, systemPrompt: body.messages.find(message => message.role === 'system')?.content, minP: body.min_p });
    return { preservedDedicatedDefaults: dedicated, inheritedRequest: requestEvidence(inherited), restoredDedicatedRequest: requestEvidence(restored) };
  });
  await run('sampling-drawer-late-save-cannot-modify-next-model', 'chat', { storeSeed: { commonChatDefaults: sharedSeed, chatOptionsByProfile: { a: legacyA } } }, async page => {
    await page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__, original = internals.invoke;
      internals.invoke = async (command, args = {}) => {
        if (command === 'strata_request' && args.path === '/settings' && args.method === 'POST') {
          window.__fixture.samplingWrite = structuredClone(args);
          await new Promise(resolve => { window.__fixture.releaseSamplingWrite = resolve; });
          const result = await original.call(internals, command, args);
          setTimeout(() => { window.__fixture.samplingWriteCompleted = true; }, 0);
          return result;
        }
        return original.call(internals, command, args);
      };
    });
    await page.locator('#sampling-btn').click();
    const shared = page.locator('#s-share');
    await page.waitForFunction(() => document.getElementById('s-share')?.disabled === false);
    await shared.click(); await page.locator('#s-temp').press('End');
    await page.locator('#s-apply').click();
    await page.waitForFunction(() => !!window.__fixture.releaseSamplingWrite);
    assert.equal(await page.evaluate(() => window.__fixture.samplingWrite.profile.id), 'a');
    await useFixtureModel(page, 'b');
    await page.waitForFunction(() => document.querySelector('.common-chat-drawer-scope')?.textContent.includes('Fixture B'));
    await page.evaluate(() => window.__fixture.releaseSamplingWrite());
    await page.waitForFunction(() => window.__fixture.samplingWriteCompleted === true);
    assert.equal(await page.locator('#s-temp').inputValue(), '0.9');
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a), legacyA);
    assert.equal(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.b), undefined);
    await page.locator('#s-apply').click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await sendChat(page, 'b', sharedSeed.temperature, sharedSeed.maxTokens);
  });
  await run('sampling-common-entry-preserves-or-saves-draft', 'chat', { storeSeed: { commonChatDefaults: sharedSeed } }, async page => {
    await page.locator('#sampling-btn').click(); await page.locator('#s-temp').press('End');
    const commonEntry = page.getByRole('button', { name: '调整公共默认值', exact: true });
    await commonEntry.click();
    const decision = page.getByRole('dialog', { name: '有未保存的改动', exact: true });
    await decision.waitFor(); await decision.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('#s-temp').inputValue(), '1.5');
    await commonEntry.click(); await decision.getByRole('button', { name: '保存并继续', exact: true }).click();
    await page.waitForURL(url => url.hash === '#chat-defaults'); await commonPanel(page);
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0 && document.getElementById('root').inert === false);
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === false);
    assert.equal(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a.temperature), 1.5);
    assert.deepEqual(await page.evaluate(() => window.__fixture.store.commonChatDefaults), sharedSeed);
    await sendChat(page, 'a', 1.5, sharedSeed.maxTokens);
    await page.locator('#sampling-btn').click(); await page.locator('#s-temp').press('Home');
    await commonEntry.click(); await decision.getByRole('button', { name: '放弃改动', exact: true }).click();
    await commonPanel(page);
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0 && document.getElementById('root').inert === false);
    assert.equal(await page.evaluate(() => window.__fixture.store.chatOptionsByProfile.a.temperature), 1.5, 'Discarding a drawer draft must keep the saved model override');
  });
  await run('structured-output-survives-common-mcp-inheritance', 'chat-defaults', { storeSeed: { commonChatDefaults: sharedSeed, chatOptionsByProfile: { a: { ...legacyA, advanced: { responseFormat: 'json_object' } } }, chatDefaultsInheritance: { a: true } } }, async page => {
    await commonPanel(page);
    assert.equal(await page.getByRole('switch', { name: '公共默认启用 MCP 工具', exact: true }).getAttribute('aria-checked'), 'true');
    const sent = await sendChat(page, 'a', sharedSeed.temperature, sharedSeed.maxTokens);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(sent.strata_mcp, undefined, 'Structured output must keep its model-specific restriction while inheriting common defaults');
    assert.equal(await page.evaluate(() => window.__fixture.store.commonChatDefaults.mcp), true);
  });
  await run('saved-common-defaults-and-inheritance-survive-reload', 'chat-defaults', { storeSeed: { commonChatDefaults: sharedSeed } }, async page => {
    await commonPanel(page);
    await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).fill('1.2');
    await page.getByRole('spinbutton', { name: '公共默认随机种子', exact: true }).fill('31');
    await choose(page, '公共默认推理强度', '适中');
    await commonValue(page, 'temperature', 1.2); await commonValue(page, 'seed', 31); await commonValue(page, 'reasoningEffort', 'medium');
    await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).click();
    await page.waitForFunction(() => window.__fixture.store.chatDefaultsInheritance.a === false && window.__fixture.store.chatOptionsByProfile.a.temperature === 1.2);
    await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).fill('1.4'); await commonValue(page, 'temperature', 1.4);
    await page.reload(); await commonPanel(page);
    assert.equal(await page.getByRole('spinbutton', { name: '公共默认温度', exact: true }).inputValue(), '1.4');
    assert.equal(await page.getByRole('spinbutton', { name: '公共默认随机种子', exact: true }).inputValue(), '31');
    assert.equal(await page.getByRole('switch', { name: '当前模型使用公共聊天默认值', exact: true }).getAttribute('aria-checked'), 'false');
    await sendChat(page, 'a', 1.2, sharedSeed.maxTokens);
  });
  await run('mcp-target-and-api-key-navigation-draft-guard', 'connections', { credentialProfiles: ['a'] }, async page => {
    await page.locator('.service-connection-panel').waitFor();
    const credential = page.getByRole('textbox', { name: 'API Key', exact: true });
    await page.waitForFunction(() => document.querySelector('input[aria-label="API Key"]').placeholder.includes('已保存'));
    assert.equal(await credential.inputValue(), '', 'Existing credentials must not be displayed');
    await choose(page, '目标服务', 'Fixture B · b.json');
    await page.getByRole('button', { name: '检查连接', exact: true }).click();
    const snippet = page.getByRole('textbox', { name: '无密钥 MCP 客户端配置', exact: true });
    await snippet.waitFor();
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'manager_mcp_connection').at(-1).args.profileId), 'b');
    assert.match(await snippet.inputValue(), /"b"/);
    assert.equal(await page.evaluate(() => window.__fixture.store.activeProfile), 'a', 'Changing the connection target must not switch the active model');
    await credential.fill('fixture-only-draft-key');
    const chatDefaults = page.locator('.workspace-subnav').getByRole('button', { name: '聊天默认', exact: true });
    await chatDefaults.click();
    const decision = page.getByRole('dialog', { name: '有未保存的改动', exact: true });
    await decision.waitFor(); await decision.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await credential.inputValue(), 'fixture-only-draft-key'); assert.match(page.url(), /#connections$/);
    await chatDefaults.click(); await decision.getByRole('button', { name: '保存并继续', exact: true }).click();
    await page.waitForURL(url => url.hash === '#chat-defaults'); await commonPanel(page);
    assert.deepEqual(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'set_api_key').map(call => call.args)), [{ profileId: 'b', apiKey: 'fixture-only-draft-key' }]);
    await page.locator('.workspace-subnav').getByRole('button', { name: 'API 与外部助手', exact: true }).click();
    await page.waitForURL(url => url.hash === '#connections');
    await page.waitForFunction(() => document.querySelector('input[aria-label="API Key"]').placeholder.includes('已保存'));
    assert.equal(await credential.inputValue(), '');
    assert.equal(await page.evaluate(() => window.__fixture.store.activeProfile), 'a');
    await credential.fill('fixture-only-discard-key');
    await choose(page, '目标服务', 'Fixture A · a.json');
    await decision.waitFor(); await decision.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await credential.inputValue(), 'fixture-only-discard-key');
    assert.match(await page.getByRole('combobox', { name: '目标服务', exact: true }).innerText(), /Fixture B/);
    await choose(page, '目标服务', 'Fixture A · a.json');
    await decision.getByRole('button', { name: '放弃改动', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="API Key"]').value === '' && document.querySelector('.service-connection-panel')?.textContent.includes('Fixture A'));
    assert.deepEqual(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'set_api_key').map(call => call.args)), [{ profileId: 'b', apiKey: 'fixture-only-draft-key' }], 'Discarding a target change must not write the abandoned key');
  });
} finally {
  if (browser) await browser.close();
  await server.close();
  const report = process.env.STRATA_COMMON_SETTINGS_CASE ? `browser-results-${process.env.STRATA_COMMON_SETTINGS_CASE.replace(/[^a-z0-9_-]/gi, '')}.json` : 'browser-results.json';
  await writeFile(resolve(output, report), JSON.stringify({ origin, scope: 'Complete React App with synthetic native IO and browser-only persistence', results }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
