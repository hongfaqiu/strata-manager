import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// First-run guide regression + optional screenshots (set ONBOARDING_SCREENSHOTS=<dir>).
// Reuses installed tools like verify.mjs; never installs or downloads anything.
const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const shots = process.env.ONBOARDING_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
// Synthetic public leaderboard sample, used only to show the speed column layout.
const arenaGroups = { computedAt: Date.now(), machines: 41, runs: 120, groups: [
  { group: 'swift:IQ3_S', family: 'swift', quant: 'IQ3_S', machines: 14, bestDecode: 39.8, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 9 }, { gpu: 'RTX 3090', vramGB: 24, machines: 5 }] },
  { group: 'qwen:IQ3_S', family: 'qwen', quant: 'IQ3_S', machines: 7, bestDecode: 36.1, gpus: [{ gpu: 'RTX 3090', vramGB: 24, machines: 4 }] },
  { group: 'coder:IQ1_M', family: 'coder', quant: 'IQ1_M', machines: 2, bestDecode: 33.0, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 2 }] },
] };
const tiers = { 'swift:IQ3_S': 35.2, 'qwen:IQ3_S': 31.4, 'coder:IQ1_M': 31.6 };
let browser; const results = [];
const only = process.env.ONBOARDING_ONLY;
async function run(name, url, action, { theme, arena = false, shot } = {}) {
  if (only && !name.includes(only)) return;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: shots ? 2 : 1, colorScheme: theme === 'dark' ? 'dark' : 'light' });
  // The webview never reaches the network: every external request is aborted. Arena data comes from the
  // native `arena_get` command, mocked in the fixture only when `arena` is set.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (arena) await context.addInitScript(([groups, tiers]) => { window.__arenaMock = { groups, tiers }; }, [arenaGroups, tiers]);
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/${url}`);
    await action(page);
    assert.deepEqual(errors, []);
    if (shots && shot) { await page.waitForTimeout(400); await page.screenshot({ path: resolve(shots, shot) }); }
    results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) { results.push({ name, passed: false }); console.log(`FAIL ${name}: ${error}`); if (process.env.ONBOARDING_DEBUG) console.log(await page.evaluate(() => window.__fixture.calls.map(call => call.command).join(' ')).catch(() => '')); if (shots) await page.screenshot({ path: resolve(shots, `failure-${name.replace(/\W+/g, '-')}.png`) }); }
  finally { await context.close(); }
}
const step = page => page.locator('[data-testid="onboarding"]').getAttribute('data-step');
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  await run('first run opens the guide entry and persists the chosen path', 'onboarding-app.html?state=entry', async page => {
    await page.waitForURL(url => url.hash === '#guide');
    await page.getByRole('heading', { name: '先让第一个模型在这台电脑上跑起来' }).waitFor();
    await page.getByText('NVIDIA GeForce RTX 4090 · 24 GB').waitFor();
    assert.equal(await page.getByRole('radio', { name: /安装第一个本地模型/ }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('.manager-nav-item', { hasText: '开始使用' }).count(), 1);
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '01-entry.png') }); }
    await page.getByRole('button', { name: '开始 · 检查环境' }).click();
    // All checks pass on this machine, so the environment step is skipped automatically.
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'runtime');
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.path === 'install');
    assert.equal(await page.locator('.ob-step.is-skipped', { hasText: '检查运行环境' }).count(), 1);
    await page.getByRole('button', { name: '开始安装' }).click();
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.runtimeTaskId === 'rt-new');
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'prepare_local_runtime').length), 1);
    assert.equal(await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'prepare_local_runtime').args.localArchives), undefined, 'downloading stays the default');
  });
  await run('runtime install can use already-downloaded Strata and engine packages', 'onboarding-app.html?state=environment#guide', async page => {
    await page.getByRole('button', { name: '继续 · 安装 Strata' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'runtime');
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '03-runtime-default-download.png') }); }
    await page.getByRole('radio', { name: '使用已下载的安装包' }).click();
    await page.getByText('请至少选择一个安装包，或改为自动下载。').waitFor();
    assert.equal(await page.getByRole('button', { name: '开始安装' }).isDisabled(), true, 'local mode needs a chosen package');
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '03a-local-packages-required.png') }); }
    await page.evaluate(() => { window.__fixture.dialogPaths = ['C:\\Downloads\\Strata-0123456789abcdef.zip', 'C:\\Downloads\\strata-windows-x64.zip']; });
    const choose = page.getByRole('button', { name: '选择文件…' });
    await choose.first().click();
    await page.locator('[data-testid="ob-archive-strataArchivePath"]').waitFor();
    await choose.nth(1).click();
    await page.locator('[data-testid="ob-archive-engineArchivePath"]').waitFor();
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '03-local-packages.png') }); }
    await page.getByRole('button', { name: '开始安装' }).click();
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.runtimeTaskId === 'rt-new');
    const args = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'prepare_local_runtime').args);
    assert.deepEqual(args.localArchives, { strataArchivePath: 'C:\\Downloads\\Strata-0123456789abcdef.zip', engineArchivePath: 'C:\\Downloads\\strata-windows-x64.zip' });
  });
  await run('environment warnings hold the environment step until accepted', 'onboarding-app.html?state=environment#guide', async page => {
    await page.getByText('未检测到显卡，生成会很慢').waitFor();
    assert.equal(await step(page), 'environment');
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '02-environment.png') }); }
    await page.getByRole('button', { name: '继续 · 安装 Strata' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'runtime');
    assert.equal(await page.evaluate(() => window.__fixture.state.store.onboardingV1.environmentAccepted), true);
  });
  await run('runtime install resumes from the persisted task', 'onboarding-app.html?state=install#guide', async page => {
    await page.getByText('正在安装运行依赖（torch、gguf）').waitFor();
    await page.getByText(/Downloading torch/).waitFor();
    assert.equal(await step(page), 'runtime');
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'prepare_local_runtime').length), 0, 'resuming never starts a second install');
  }, { shot: '03-install.png' });
  await run('model step recommends what fits and shows public Arena speeds', 'onboarding-app.html?state=model#guide', async page => {
    await page.getByRole('radio', { name: /Swift 1\.5\s*IQ3_S/ }).waitFor();
    assert.equal(await step(page), 'model');
    await page.getByText('35.2').waitFor();
    const board = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'arena_get' && call.args.path === 'leaderboard' && call.args.query?.group === 'swift:IQ3_S')?.args.query);
    assert.ok(board && (board.gpu || board.vram), 'leaderboard is read through arena_get with a query map');
    assert.equal(await page.getByRole('radio', { name: /Swift 1\.5\s*IQ3_S/ }).getAttribute('aria-checked'), 'true');
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'assess_setup_resources'));
    await page.locator('[data-testid="resource-assessment"][data-status="suggested"]').waitFor();
  }, { arena: true, shot: '04-model.png' });
  await run('model step degrades offline and starts the real setup task', 'onboarding-app.html?state=model-offline#guide', async page => {
    await page.getByText('暂时读不到排行榜数据，不影响下载。').waitFor();
    assert.ok(await page.locator('.ob-model .cat-est-tag').count() >= 3, 'rows without Arena data show a labelled 估算, not "尚无实测"');
    await page.locator('[data-testid="resource-assessment"][data-status="suggested"]').waitFor();
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '04b-model-offline.png') }); }
    await page.getByRole('button', { name: /下载并准备/ }).click();
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.setupTaskId === 'setup-new');
    const setup = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'run_setup').args);
    assert.equal(setup.model, 'swift'); assert.equal(setup.quant, 'IQ3_S');
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'download');
    assert.equal(await page.getByRole('switch', { name: '下载完成后自动启动并加载' }).getAttribute('aria-checked'), 'false', 'auto start defaults to off');
  });
  await run('a download that cannot reach Hugging Face offers a one-click ModelScope retry', 'onboarding-app.html?state=model-offline&fail=unreachable#guide', async page => {
    await page.getByRole('button', { name: /下载并准备/ }).click();
    const retry = page.getByRole('button', { name: '改用国内源 ModelScope 重试' });
    await retry.waitFor();
    await page.getByRole('button', { name: '重新选择模型' }).waitFor();
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '04c-download-unreachable.png') }); }
    await retry.click();
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.setupTaskId === 'setup-new-2');
    const runs = await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'run_setup').map(call => call.args.options));
    assert.equal(runs.length, 2);
    assert.equal(runs[0].source, 'official'); assert.equal(runs[1].source, 'modelscope');
    assert.equal(await page.getByRole('button', { name: '改用国内源 ModelScope 重试' }).count(), 0, 'the retry is running; no second button');
  });
  await run('Mac 48 GB model step greys out unsupported families and explains SSD streaming', 'onboarding-app.html?state=model&mac=m5pro#guide', async page => {
    await page.getByRole('radio', { name: /Qwen3\.8-Flash-Next\s*Q2_0/ }).waitFor();
    const blocked = page.locator('[data-testid="ob-mac-unavailable"]');
    await blocked.getByText('Swift 1.5').waitFor();
    assert.equal(await page.getByRole('radio', { name: /Swift/ }).count(), 0, 'Swift is never offered on a Mac');
    assert.equal(await page.getByRole('radio', { name: /Unsloth/ }).count(), 0, 'the Mac installer takes only --family qwen');
    await page.locator('[data-testid="mac-unsloth-installer"]').getByText(/只接受 Qwen3\.8-Flash-Next/).waitFor();
    assert.equal(await page.getByRole('radio', { name: /IQ2_XS|UD-IQ4_XS/ }).count(), 0, 'only the Mac sizes are offered');
    await page.getByText(/不会失败，只是更慢/).first().waitFor();
    await page.getByRole('link', { name: /MAC\.md/ }).first().waitFor();
  }, { shot: 'catalog-mac-48gb-official.png' });
  await run('community scope labels sources and risks, and blocks Mac-only gaps with the reason', 'onboarding-app.html?state=model&mac=m5pro#guide', async page => {
    await page.locator('[data-testid="ob-model-scope"]').getByText('社区 · 无审查').click();
    await page.getByRole('radio', { name: /SC117 abliterated\s*Q2_0/ }).waitFor();
    await page.getByText('去拒答向量在 Mac 引擎未移植，等同官方版。').first().waitFor();
    await page.getByText(/gemv/).first().waitFor();
    await page.getByText(/MTP 草稿头没有做去审查/).waitFor();
    await page.getByRole('link', { name: /SC117\/Qwen3\.8-Flash-Next-GSQ-RCO-abliterated-GGUF/ }).waitFor();
    await page.locator('[data-testid="community-disk"]').getByText(/预计额外占用磁盘/).waitFor();
    await page.getByText(/以硬链接复用/).waitFor();
    await page.getByRole('radio', { name: /example-user/ }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'hf_models_api' && call.args.path.startsWith('/api/models/ISTA-DASLab')).length), 0, 'official repos are not re-discovered');
  }, { shot: 'catalog-mac-48gb-community.png' });
  await run('community download pins the revision and runs the community setup', 'onboarding-app.html?state=model-offline&hf=offline#guide', async page => {
    await page.locator('[data-testid="ob-model-scope"]').getByText('社区 · 无审查').click();
    await page.getByText('无法连接 Hugging Face，只显示内置条目').waitFor();
    await page.getByRole('radio', { name: /SC117 abliterated\s*IQ3_XXS/ }).click();
    await page.getByRole('button', { name: /下载并准备/ }).click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'run_community_setup'));
    const args = await page.evaluate(() => window.__fixture.calls.find(call => call.command === 'run_community_setup').args);
    assert.equal(args.request.slug, 'sc117-abliterated'); assert.equal(args.request.quant, 'IQ3_XXS');
    assert.match(args.request.revision, /^[0-9a-f]{40}$/);
    assert.equal(args.request.files.length, 2); assert.ok(args.request.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
  });
  await run('download step shows live task progress', 'onboarding-app.html?state=download#guide', async page => {
    await page.getByText('Swift 1.5 IQ3_S 下载中 31.2 / 83.6 GB').waitFor();
    assert.equal(await page.locator('.ob-bignum').innerText(), '37%');
  }, { shot: '05-download.png' });
  await run('download step in dark theme', 'onboarding-app.html?state=download&theme=dark#guide', async page => {
    await page.getByText('Swift 1.5 IQ3_S 下载中 31.2 / 83.6 GB').waitFor();
  }, { theme: 'dark', shot: '05-download-dark.png' });
  await run('start step starts the registered profile and shows startup logs', 'onboarding-app.html?state=start#guide', async page => {
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'start');
    await page.getByRole('button', { name: '启动并加载' }).click();
    await page.getByText('本机 API 已就绪，正在加载模型').waitFor();
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'switch_local_service').map(call => call.args.profileId).join()), 'swift-iq3');
  }, { shot: '06-start.png' });
  await run('loaded model completes the guide from the first chat', 'onboarding-app.html?state=ready#guide', async page => {
    await page.getByRole('heading', { name: '模型已就绪' }).waitFor();
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '07-ready.png') }); }
    await page.getByRole('button', { name: '用三句话介绍一下你自己' }).click();
    await page.waitForURL(url => url.hash === '#chat');
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.status === 'completed');
    assert.equal(await page.locator('.manager-nav-item', { hasText: '开始使用' }).count(), 0, 'sidebar item hides after completion');
  });
  await run('connect path lists configured services', 'onboarding-app.html?state=connect#guide', async page => {
    await page.getByText('Qwen3.8-Flash-Next IQ3_XXS').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'discover');
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '08-connect.png') }); }
    await page.getByRole('button', { name: '启动', exact: true }).first().click();
    await page.waitForFunction(() => window.__fixture.calls.some(call => call.command === 'import_local'));
    // Importing registers the configuration and starts it; the guide then moves on to the load step by itself.
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step !== 'discover');
  });
  await run('connect path detects an auto-connected running service', 'onboarding-app.html?state=connect-running#guide', async page => {
    // The app already adopts running services on its own; the guide only has to notice and move on.
    await page.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.dataset.step === 'load');
    await page.getByText('http://127.0.0.1:18081').waitFor();
    assert.equal(await page.locator('.ob-step.is-done', { hasText: '发现本机服务' }).count(), 1);
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.command === 'connect_running_service').length), 1);
  }, { shot: '08b-connect-running.png' });
  await run('overview shows the resume strip while the guide is active', 'onboarding-app.html?state=overview#overview', async page => {
    await page.getByTestId('guide-resume').waitFor();
    await page.getByText('第 4/6 步：下载模型').waitFor();
    assert.equal(await page.locator('.manager-nav-item', { hasText: '开始使用' }).locator('.manager-nav-badge').innerText(), '3/6');
  }, { shot: '09-overview.png' });
  await run('skipped guide keeps the old empty overview with a reopen link', 'onboarding-app.html?state=skipped#overview', async page => {
    await page.getByRole('button', { name: '打开开始使用' }).waitFor();
    assert.equal(await page.getByTestId('guide-resume').count(), 0);
    assert.equal(await page.locator('.manager-nav-item', { hasText: '开始使用' }).count(), 0);
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '10-overview-skipped.png') }); }
    await page.getByRole('button', { name: '打开开始使用' }).click();
    await page.waitForURL(url => url.hash === '#guide');
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.status === 'active');
  });
  await run('settings can reopen a completed guide', 'onboarding-app.html?state=settings#settings', async page => {
    await page.getByRole('button', { name: '重新打开' }).waitFor();
    if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: resolve(shots, '11-settings-reopen.png') }); }
    await page.getByRole('button', { name: '重新打开' }).click();
    await page.waitForURL(url => url.hash === '#guide');
    await page.waitForFunction(() => window.__fixture.state.store.onboardingV1?.status === 'active');
  });
} finally { await browser?.close(); await server.close(); }
const failed = results.filter(result => !result.passed);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
