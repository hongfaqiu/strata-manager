import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 18743, strictPort: true, fs: { allow: [root] } }, clearScreen: false });
const output = resolve(root, 'output/playwright/runtime-update-download');
await mkdir(output, { recursive: true }); await server.listen();
const failures = [], results = [], summaryChecks = [], scrollChecks = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  const chooseAsset = async (scope, label, asset) => {
    await scope.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: asset.includes('cuda12') ? 'CUDA12' : 'CUDA13', exact: true }).click();
  };
  const chooseSource = async (scope, zh, source, dialog = false) => {
    const name = dialog ? zh ? '引擎 ZIP 下载方式' : 'Engine ZIP source' : zh ? '下载方式' : 'Download source';
    const label = source === 'official' ? zh ? '官方自动下载' : 'Official download' : source === 'local' ? zh ? '本地已下载 ZIP' : 'Downloaded ZIP' : source === 'gh-proxy' ? 'GH Proxy' : source === 'ghproxy' ? 'GHProxy' : zh ? '自定义 HTTPS' : 'Custom HTTPS';
    await scope.getByRole('combobox', { name, exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  };
  for (const language of ['zh-CN', 'en']) {
    const zh = language === 'zh-CN';
    await page.setViewportSize({ width: 1100, height: 960 });
    await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}`);
    await page.evaluate(() => sessionStorage.clear()); await page.reload();
    const initialSettings = page.getByRole('region', { name: zh ? '下载设置与测试' : 'Download settings and test' });
    const initialUpdate = page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' });
    await initialUpdate.waitFor();
    assert.equal(await initialSettings.getByRole('combobox', { name: zh ? '下载设置官方包' : 'Download settings official package' }).isVisible(), false);
    assert.equal(await initialUpdate.isVisible(), true);
    assert.ok((await initialUpdate.boundingBox()).y < (await initialSettings.boundingBox()).y, 'the primary update action must precede optional download settings');
    await page.screenshot({ path: resolve(output, `${language}-summary.png`), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await initialUpdate.isVisible(), true);
    assert.equal(await initialSettings.getByRole('combobox', { name: zh ? '下载设置官方包' : 'Download settings official package' }).isVisible(), false);
    await page.screenshot({ path: resolve(output, `${language}-summary-375.png`), fullPage: true });
    summaryChecks.push({ language, widths: [1100, 375], downloadSettingsInitiallyCollapsed: true, updateActionPrecedesSettings: true, horizontalOverflow: false });
    for (const mode of ['official', 'local', 'mirror']) {
      await page.setViewportSize({ width: 1100, height: 960 });
      await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}`);
      await page.evaluate(() => sessionStorage.clear());
      await page.reload();
      await page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: zh ? '确认更新' : 'Confirm update', exact: true }).waitFor();
      const confirm = dialog.getByRole('button', { name: zh ? '确认更新' : 'Confirm update', exact: true });
      await page.waitForFunction(() => !document.querySelector('.runtime-update-dialog-actions .primary')?.disabled);
      assert.equal(await dialog.locator('input[type="radio"], select').count(), 0);
      assert.equal(await dialog.locator('.official-dropdown').count(), 2);
      const name = 'strata-windows-x64-cuda12.zip';
      await chooseAsset(dialog, zh ? '官方更新包' : 'Official update package', name);
      await dialog.locator('summary').filter({ hasText: zh ? '包信息' : 'Package details' }).click();
      const url = `https://github.com/Niko1221/Strata/releases/download/v0.1.43/${name}`;
      assert.equal(await dialog.getByRole('link', { name: url, exact: true }).getAttribute('href'), url);
      assert.match(await dialog.innerText(), /SHA256: 222222/);
      await dialog.getByRole('button', { name: zh ? `复制下载链接 ${name}` : `Copy download URL ${name}` }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
      await dialog.getByRole('button', { name: zh ? `复制 SHA256 ${name}` : `Copy SHA256 ${name}` }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '2'.repeat(64));
      if (mode === 'local') {
        await chooseSource(dialog, zh, 'local', true);
        assert.equal(await confirm.isDisabled(), true);
        await page.evaluate(() => { window.__fixture.pick = null; });
        await dialog.getByRole('button', { name: zh ? '选择 ZIP 文件' : 'Choose ZIP file' }).click();
        assert.equal(await confirm.isDisabled(), true);
        await page.evaluate(() => { window.__fixture.pick = 'D:\\Downloads\\Strata engine.zip'; });
        await dialog.getByRole('button', { name: zh ? '选择 ZIP 文件' : 'Choose ZIP file' }).click();
        await dialog.getByText('D:\\Downloads\\Strata engine.zip', { exact: true }).waitFor();
      } else if (mode === 'mirror') {
        await chooseSource(dialog, zh, 'custom', true);
        const input = dialog.getByRole('textbox', { name: zh ? 'HTTPS 镜像地址' : 'HTTPS mirror URL', exact: true });
        await input.fill('http://mirror.example/file.zip'); assert.equal(await confirm.isDisabled(), true);
        await input.fill('https://mirror.example/Strata-cuda12.zip?token=fixture');
      }
      assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'update_runtime_zip').length), 0);
      await page.screenshot({ path: resolve(output, `${language}-${mode}.png`), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
      await page.screenshot({ path: resolve(output, `${language}-${mode}-375.png`), fullPage: true });
      await confirm.click(); await dialog.waitFor({ state: 'hidden' });
      const calls = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'update_runtime_zip'));
      assert.equal(calls.length, 1); assert.equal(calls[0].args.assetName, name); assert.equal(calls[0].args.stopCurrentService, true);
      if (mode === 'local') assert.equal(calls[0].args.localArchivePath, 'D:\\Downloads\\Strata engine.zip');
      else if (mode === 'mirror') assert.equal(calls[0].args.downloadUrl, 'https://mirror.example/Strata-cuda12.zip?token=fixture');
      else { assert.equal(calls[0].args.localArchivePath, undefined); assert.equal(calls[0].args.downloadUrl, undefined); }
      results.push({ language, mode, narrowViewport: 375, nativeCalls: calls });
    }
    for (const mode of ['official', 'local', 'mirror']) {
      await page.setViewportSize({ width: 1100, height: 960 });
      await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}`);
      await page.evaluate(() => sessionStorage.clear()); await page.reload();
      const settings = page.getByRole('region', { name: zh ? '下载设置与测试' : 'Download settings and test' });
      await settings.locator('summary').filter({ hasText: zh ? '下载设置与测试' : 'Download settings and test' }).click();
      await settings.locator('summary').filter({ hasText: zh ? '包信息' : 'Package details' }).click();
      await settings.locator('summary').filter({ hasText: zh ? '更多说明' : 'More information' }).click();
      const asset = 'strata-windows-x64-cuda12.zip';
      await chooseAsset(settings, zh ? '下载设置官方包' : 'Download settings official package', asset);
      await chooseSource(settings, zh, mode === 'mirror' ? 'custom' : mode);
      assert.equal(await settings.locator('input[type="radio"], select').count(), 0);
      assert.equal(await settings.locator('.official-segmented').count(), 0);
      assert.equal(await settings.locator('.official-dropdown').count(), 2);
      if (mode === 'official') {
        const sourceCombo = settings.getByRole('combobox', { name: zh ? '下载方式' : 'Download source', exact: true });
        await sourceCombo.focus(); await sourceCombo.press('ArrowDown'); await sourceCombo.press('End'); await sourceCombo.press('Enter');
        assert.match(await sourceCombo.innerText(), zh ? /本地已下载 ZIP/ : /Downloaded ZIP/);
        await sourceCombo.press('ArrowDown'); await sourceCombo.press('Home'); await sourceCombo.press('Enter');
        assert.match(await sourceCombo.innerText(), zh ? /官方自动下载/ : /Official download/);
        const combo = settings.getByRole('combobox', { name: zh ? '下载设置官方包' : 'Download settings official package' });
        await combo.focus(); await combo.press('ArrowDown'); await combo.press('End'); await combo.press('Enter');
        assert.ok((await combo.innerText()).includes('CUDA12'));
      }
      if (mode === 'local') await settings.getByRole('button', { name: zh ? '选择 ZIP 文件' : 'Choose ZIP file', exact: true }).click();
      if (mode === 'mirror') await settings.getByRole('textbox', { name: zh ? '镜像地址或模板' : 'Mirror URL or template' }).fill('https://mirror.example/Strata-cuda12.zip');
      await settings.getByRole('button', { name: zh ? '保存下载设置' : 'Save download settings', exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set' && call.args.key === 'runtimeDownloadPreferences'));
      await settings.getByRole('button', { name: zh ? '测试下载来源' : 'Test download source', exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'test_runtime_zip_download'));
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('Testing') || button.textContent.includes('正在测试')));
      const tests = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'test_runtime_zip_download'));
      assert.equal(tests.length, 1); assert.equal(tests[0].args.assetName, asset);
      if (mode === 'local') assert.equal(tests[0].args.localArchivePath, 'D:\\Downloads\\Strata engine.zip');
      if (mode === 'mirror') assert.equal(tests[0].args.downloadUrl, 'https://mirror.example/Strata-cuda12.zip');
      assert.equal(await page.evaluate(() => window.__fixture.tasks.length), 0);
      assert.equal(await page.evaluate(() => window.__fixture.calls.some(call => /update_runtime_zip|stop_service|start_service/.test(call.command))), false);
      const testResult = settings.locator('.runtime-download-settings-result');
      await testResult.waitFor();
      await testResult.locator('summary').filter({ hasText: zh ? '测试详情' : 'Test details' }).click();
      const text = await testResult.innerText();
      if (mode === 'local') {
        assert.match(text, zh ? /本地完整 SHA256 校验通过/ : /Full local SHA256 verification passed/);
        assert.match(text, /137,300,495/);
        assert.doesNotMatch(text, /Range/);
      } else {
        assert.match(text, /65,536/);
        assert.match(text, zh ? /完整文件 SHA256 尚未验证|尚未验证完整文件 SHA256/ : /full (?:file )?SHA256 remains unverified/);
        assert.match(text, zh ? /Range.*支持/ : /Range.*Supported/);
      }
      await page.screenshot({ path: resolve(output, `${language}-settings-${mode}.png`), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(output, `${language}-settings-${mode}-375.png`), fullPage: true });
      await page.reload();
      await page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' }).click();
      const dialog = page.getByRole('dialog');
      const savedSource = dialog.getByRole('combobox', { name: zh ? '引擎 ZIP 下载方式' : 'Engine ZIP source', exact: true });
      await savedSource.waitFor();
      assert.match(await savedSource.innerText(), mode === 'official' ? zh ? /官方自动下载/ : /Official download/ : mode === 'local' ? zh ? /本地已下载 ZIP/ : /Downloaded ZIP/ : zh ? /自定义 HTTPS/ : /Custom HTTPS/);
      assert.ok((await dialog.getByRole('combobox', { name: zh ? '官方更新包' : 'Official update package' }).innerText()).includes('CUDA12'));
      if (mode === 'local') await dialog.getByText('D:\\Downloads\\Strata engine.zip', { exact: true }).waitFor();
      if (mode === 'mirror') assert.equal(await dialog.getByRole('textbox', { name: zh ? 'HTTPS 镜像地址' : 'HTTPS mirror URL', exact: true }).inputValue(), 'https://mirror.example/Strata-cuda12.zip');
      assert.equal(await page.evaluate(() => window.__fixture.calls.some(call => /update_runtime_zip|stop_service|start_service/.test(call.command))), false);
      results.push({ language, mode: `settings-${mode}`, savedAcrossReload: true, createsUpdateTask: false, officialControls: true, ...(mode === 'official' ? { keyboardControls: true } : {}) });
    }
    for (const source of ['local', 'literal', 'template']) {
      await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}&latest`);
      await page.evaluate(() => sessionStorage.clear()); await page.reload();
      const settings = page.getByRole('region', { name: zh ? '下载设置与测试' : 'Download settings and test' });
      await settings.locator('summary').filter({ hasText: zh ? '下载设置与测试' : 'Download settings and test' }).click();
      const asset = 'strata-windows-x64-cuda12.zip';
      assert.equal(await page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' }).count(), 0);
      await chooseAsset(settings, zh ? '下载设置官方包' : 'Download settings official package', asset);
      await chooseSource(settings, zh, source === 'local' ? 'local' : 'custom');
      if (source === 'local') await settings.getByRole('button', { name: zh ? '选择 ZIP 文件' : 'Choose ZIP file', exact: true }).click();
      else await settings.getByRole('textbox', { name: zh ? '镜像地址或模板' : 'Mirror URL or template' }).fill(source === 'template' ? 'https://mirror.example/{version}/{asset}?upstream={url}' : 'https://mirror.example/old-release.zip');
      await settings.getByRole('button', { name: zh ? '保存下载设置' : 'Save download settings', exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set'));
      await settings.getByRole('button', { name: zh ? '测试下载来源' : 'Test download source', exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'test_runtime_zip_download'));
      await page.evaluate(() => {
        const release = window.__fixture.release;
        release.latestVersion = '0.1.44'; release.releaseName = 'Strata 0.1.44'; release.checkedAt += 1;
        release.assets.forEach(asset => { asset.url = asset.url.replace('0.1.43', '0.1.44'); asset.sha256 = '3'.repeat(64); });
      });
      await page.getByRole('button', { name: zh ? '检查更新' : 'Check for updates', exact: true }).click();
      await page.getByRole('button', { name: zh ? '更新至 0.1.44' : 'Update to 0.1.44' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: zh ? '确认更新' : 'Confirm update', exact: true }).waitFor();
      const confirm = dialog.getByRole('button', { name: zh ? '确认更新' : 'Confirm update', exact: true });
      if (source === 'template') {
        const expected = `https://mirror.example/0.1.44/${asset}?upstream=https://github.com/Niko1221/Strata/releases/download/v0.1.44/${asset}`;
        assert.equal(await dialog.getByRole('textbox', { name: zh ? 'HTTPS 镜像地址' : 'HTTPS mirror URL', exact: true }).inputValue(), 'https://mirror.example/{version}/{asset}?upstream={url}');
        await page.waitForFunction(() => !document.querySelector('.runtime-update-dialog-actions .primary')?.disabled);
        assert.equal(await confirm.isDisabled(), false);
        assert.equal(await page.evaluate(() => window.__fixture.calls.some(call => /update_runtime_zip|stop_service|start_service/.test(call.command))), false);
        await confirm.click(); await dialog.waitFor({ state: 'hidden' });
        const accepted = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'update_runtime_zip'));
        assert.equal(accepted.args.downloadUrl, expected);
      } else {
        assert.equal(await confirm.isDisabled(), true, 'an exact source bound to an old release must require reselection');
        if (source === 'literal') assert.equal(await dialog.getByRole('textbox', { name: zh ? 'HTTPS 镜像地址' : 'HTTPS mirror URL', exact: true }).inputValue(), '');
        else assert.equal(await dialog.getByText('D:\\Downloads\\Strata engine.zip', { exact: true }).count(), 0);
      }
      if (source !== 'template') assert.equal(await page.evaluate(() => window.__fixture.calls.some(call => /update_runtime_zip|stop_service|start_service/.test(call.command))), false);
      results.push({ language, mode: `latest-and-release-change-${source}`, latestConfigurationEnabled: true, staleExactSourceBlocked: source !== 'template' });
    }
    for (const source of ['gh-proxy', 'ghproxy']) {
      await page.setViewportSize({ width: 1100, height: 960 });
      await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}`);
      await page.evaluate(() => sessionStorage.clear()); await page.reload();
      const settings = page.getByRole('region', { name: zh ? '下载设置与测试' : 'Download settings and test' });
      await settings.locator('summary').filter({ hasText: zh ? '下载设置与测试' : 'Download settings and test' }).click();
      await chooseSource(settings, zh, source);
      await settings.getByText(zh ? '自动匹配 · CUDA12' : 'Auto matched · CUDA12', { exact: true }).waitFor();
      await settings.getByRole('button', { name: zh ? '保存下载设置' : 'Save download settings', exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'store_set'));
      const saved = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'store_set').args.value);
      assert.equal(saved.sourceId, source); assert.equal(saved.assetName, undefined);
      await settings.getByRole('button', { name: zh ? '测试下载来源' : 'Test download source', exact: true }).click();
      await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'test_runtime_zip_download'));
      const test = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'test_runtime_zip_download'));
      const prefix = source === 'ghproxy' ? 'https://ghproxy.net/' : 'https://gh-proxy.org/';
      assert.equal(test.args.assetName, 'strata-windows-x64-cuda12.zip');
      assert.equal(test.args.downloadUrl, `${prefix}https://github.com/Niko1221/Strata/releases/download/v0.1.43/strata-windows-x64-cuda12.zip`);
      const presetResult = settings.locator('.runtime-download-settings-result');
      await presetResult.waitFor();
      await page.screenshot({ path: resolve(output, `${language}-preset-${source}-compact.png`), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: resolve(output, `${language}-preset-${source}-compact-375.png`), fullPage: true });
      await page.setViewportSize({ width: 1100, height: 960 });
      await presetResult.locator('summary').filter({ hasText: zh ? '测试详情' : 'Test details' }).click();
      await page.screenshot({ path: resolve(output, `${language}-preset-${source}.png`), fullPage: true });
      await page.setViewportSize({ width: 375, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(output, `${language}-preset-${source}-375.png`), fullPage: true });
      await page.reload();
      await page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' }).click();
      const dialog = page.getByRole('dialog');
      assert.match(await dialog.getByRole('combobox', { name: zh ? '引擎 ZIP 下载方式' : 'Engine ZIP source' }).innerText(), source === 'ghproxy' ? /GHProxy/ : /GH Proxy/);
      await dialog.getByText(zh ? '自动匹配 · CUDA12' : 'Auto matched · CUDA12', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__fixture.calls.some(call => /update_runtime_zip|stop_service|start_service/.test(call.command))), false);
      results.push({ language, mode: `preset-${source}`, autoMatchedEngine: 'cuda12', preferenceKeepsAutomaticPackage: true });
    }
    await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}&unknown`);
    await page.evaluate(() => sessionStorage.clear()); await page.reload();
    await page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' }).click();
    const unknownDialog = page.getByRole('dialog');
    await unknownDialog.getByRole('alert').filter({ hasText: zh ? '自动匹配失败' : 'Automatic matching failed' }).waitFor();
    assert.equal(await unknownDialog.getByRole('button', { name: zh ? '确认更新' : 'Confirm update', exact: true }).isDisabled(), true);
    await chooseAsset(unknownDialog, zh ? '官方更新包' : 'Official update package', 'strata-windows-x64-cuda12.zip');
    await page.waitForFunction(() => !document.querySelector('.runtime-update-dialog-actions .primary')?.disabled);
    results.push({ language, mode: 'unknown-engine-requires-explicit-override', guessedFirstPackage: false });
    await page.goto(`http://127.0.0.1:18743/runtime-update-download.html?${language}`);
    await page.evaluate(() => sessionStorage.clear()); await page.reload();
    await page.evaluate(() => { window.__fixture.release.notes = '## Long release notes\n\n' + Array.from({ length: 180 }, (_, i) => `- Entry ${i + 1}: long release note with bounded scrolling. 更新日志。`).join('\n'); });
    await page.getByRole('button', { name: zh ? '检查更新' : 'Check for updates', exact: true }).click();
    await page.locator('.runtime-release-notes > summary').click();
    const scrollableAncestors = locator => locator.evaluate(element => {
      let count = 0;
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 2) count++;
      }
      return count;
    });
    for (const width of [1100, 375]) {
      await page.setViewportSize({ width, height: 812 });
      const count = await scrollableAncestors(page.locator('.runtime-release-body'));
      assert.ok(count <= 1, 'panel release notes must not have nested scrolling');
      scrollChecks.push({ language, surface: 'panel', width, scrollableAncestors: count });
      await page.screenshot({ path: resolve(output, `${language}-long-notes-panel-${width}.png`), fullPage: false });
    }
    await page.getByRole('button', { name: zh ? '更新至 0.1.43' : 'Update to 0.1.43' }).click();
    const longDialog = page.getByRole('dialog');
    await longDialog.locator('.runtime-update-release-details > summary').click();
    for (const width of [1100, 375]) {
      await page.setViewportSize({ width, height: 812 });
      const count = await scrollableAncestors(longDialog.locator('.runtime-update-notes'));
      assert.ok(count <= 1, 'dialog release notes must use a single scroll area');
      scrollChecks.push({ language, surface: 'dialog', width, scrollableAncestors: count });
      await page.screenshot({ path: resolve(output, `${language}-long-notes-dialog-${width}.png`), fullPage: false });
    }
    results.push({ language, mode: 'long-release-notes', widths: [1100, 375], nestedScrollbars: false });
  }
  assert.deepEqual(failures, []);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, summaryChecks, scrollChecks, browserErrors: failures, nativeIO: 'isolated mock; no real upgrade' }, null, 2));
  console.log(`Runtime download browser checks passed: ${results.length} flows, zero browser errors. Native IO used an isolated fixture, not a real upgrade.`);
} finally { await browser?.close(); await server.close(); }
