/** Capture actual UI components with isolated native fixtures; never start a model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const fixture = join(root, 'apps/desktop/tests/optimization');
const output = join(root, 'output/playwright/daily-experience-capture');
const destination = join(root, 'docs/screenshots/daily-experience');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const currentVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_) if (!['--prepare', '--capabilities-ready', '--probe-history-narrow'].includes(argument)) throw Error(`Unknown argument: ${argument}`);
const probeHistory = arguments_.has('--probe-history-narrow');
const manifestPath = join(output, probeHistory ? 'probe-history-narrow.json' : 'manifest.json');
const python = process.env.STRATA_PYTHON_EXECUTABLE || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const playwright = process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright');
const sourceRoots = ['apps/desktop/src', 'packages/core/src', 'apps/desktop/src-tauri/src', 'apps/desktop/src-tauri/capabilities'];
const sourceFiles = ['CHANGELOG.md', 'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src-tauri/tauri.dev.conf.json'];
const helperFiles = ['scripts/capture-daily-experience.mjs', ...['native-fixture.js', 'app-update-native-fixture.js', 'daily-experience-native-fixture.js', 'entry.tsx', 'daily-experience-app.html', 'api-usage-entry.tsx', 'api-usage-app.html'].map(file => `apps/desktop/tests/optimization/${file}`)];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = path => relative(root, path).replaceAll('\\', '/');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error(`Source symlink is outside the capture contract: ${normalized(join(directory, entry.name))}`);
    if (entry.isDirectory()) {
      if (!['node_modules', 'target', 'dist', 'generated'].includes(entry.name)) files.push(...await filesUnder(join(directory, entry.name)));
    } else if (entry.isFile()) files.push(join(directory, entry.name));
  }
  return files;
}

async function snapshot() {
  const production = [...sourceFiles.map(file => join(root, file)), ...(await Promise.all(sourceRoots.map(path => filesUnder(join(root, path))))).flat()];
  const hashFiles = async paths => Promise.all([...new Set(paths)].sort().map(async file => ({ file: normalized(file), sha256: digest(await readFile(file)) })));
  const sources = await hashFiles(production);
  const helpers = await hashFiles(helperFiles.map(file => join(root, file)));
  const treeHash = entries => digest(entries.map(({ file, sha256 }) => `${file}\0${sha256}\0`).join(''));
  return { head: run('git', ['rev-parse', 'HEAD']).trim(), sourceTreeSha256: treeHash(sources), helperTreeSha256: treeHash(helpers), sources, helpers };
}

async function ready() {
  const state = JSON.parse(await readFile(join(root, '.local/model-download-redesign-status.json'), 'utf8'));
  assert.equal(state.state, 'ready', 'The model download owner must mark state=ready before capture.');
  assert.ok(arguments_.has('--capabilities-ready'), 'Capture needs --capabilities-ready after the finishing owner confirms capability wiring and fixture identity.');
  return state;
}

const pillow = JSON.parse(run(python, ['-c', "import json; from PIL import Image, features; print(json.dumps({'pillow':Image.__version__, 'webp':features.check('webp')}))"]).trim());
assert.ok(pillow.webp, 'The bundled Python must support WebP.');
await stat(playwright);
const { chromium } = await import(pathToFileURL(playwright).href);
const browserCandidates = process.env.STRATA_BROWSER_EXECUTABLE ? [process.env.STRATA_BROWSER_EXECUTABLE] : [
  chromium.executablePath(),
  ...(process.platform === 'win32' ? [join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')] : []),
];
let browserExecutable;
for (const candidate of browserCandidates) if (await stat(candidate).then(value => value.isFile()).catch(() => false)) { browserExecutable = candidate; break; }
assert.ok(browserExecutable, 'No existing browser was found. Set STRATA_BROWSER_EXECUTABLE; this capture tool never downloads a browser.');
if (arguments_.has('--prepare')) {
  console.log(JSON.stringify({ prepared: true, captureNotStarted: true, playwright, browserExecutable, python, pillow, cases: 16, narrowQaCases: 32, waitingFor: ['model download state=ready', 'finishing owner capability confirmation'] }, null, 2));
  process.exit(0);
}

const readiness = await ready();
const before = await snapshot();
const manifest = {
  schemaVersion: 1,
  appVersion: currentVersion,
  releaseStatus: 'unreleased',
  capturedAt: new Date().toISOString(),
  status: 'running',
  source: 'Real App components via daily-experience-app.html; API usage is a standalone real ApiUsagePage fixture.',
  scope: 'Synthetic in-memory native data, service capabilities, SSE answers, history, GPU/RAM and statistics. No real model, supervisor, credentials, installer, updater, benchmark or OS mutation.',
  imageScope: '16 light-theme screenshots: the four model-download list/detail images use a real 1440x1200 viewport so the resource card fits above the footer; the other twelve use 1440x960. Separate 800px QA covers each scene in Chinese/English and light/dark. API usage retains the standalone fixture toolbar and is not a whole-App screenshot.',
  probeOnly: probeHistory,
  viewport: { width: 1440, height: 960, deviceScaleFactor: 2 },
  alternateViewports: [{ scenes: ['model-download-list', 'model-download-detail'], width: 1440, height: 1200, deviceScaleFactor: 2, reason: 'The 960px-height viewport clips resource-guidance figures behind the fixed download footer. A real taller viewport preserves the complete actual component without CSS/DOM changes.' }],
  readiness: { task: readiness.task, state: readiness.state },
  capabilitiesApprovedByFinishingOwner: true,
  sourceProvenance: { captureHEAD: before.head, captureHEADIsFinalReleaseSHA: false, hashScope: 'All files under apps/desktop/src, packages/core/src, desktop native src/capabilities, plus the current CHANGELOG.md read by App, package/lock/config files; tracked and untracked files included. Helpers independently hashed. Paths and raw-file SHA256 values sorted and NUL-delimited.', before },
  captures: [],
  narrowQa: [],
  browser: {},
  conversion: { tool: 'Bundled Python/Pillow', pillow, lossless: true, pixelEquality: 'RGBA byte equality after PNG/WebP decoding' },
};
await mkdir(output, { recursive: true });
await mkdir(join(output, 'webp'), { recursive: true });
await mkdir(join(output, 'qa'), { recursive: true });
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false });
const browserArguments = ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
let browser, origin;

// Install the guard before fixture scripts. Every invoke stays inside the known
// synthetic bridge; lifecycle, installation, download and settings mutations fail.
function nativeGuard() {
  const safety = window.__captureSafety = { calls: [], forbidden: [] };
  const deny = /^(?:start_service|switch_local_service|ensure_local_service|restart_service|stop_service|take_over_service|set_service_auth|set_external_management|run_setup|install_runtime|import_runtime_zip|update_runtime|prepare_app_update|tuning_start|tuning_start_full_v1|cancel_task)$/;
  let bridge;
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: false, get: () => bridge, set: value => {
    assertSyntheticObject(value);
    let invoke = value.invoke;
    const wrap = fn => async (command, args = {}) => {
      safety.calls.push({ command, method: args.method ?? null, path: args.path ?? null });
      const blocked = !window.__fixture || deny.test(command) || /^plugin:updater\|(?:download|install|download_and_install)$/.test(command) || command === 'strata_request' && args.method && args.method !== 'GET';
      if (blocked) { safety.forbidden.push(command); throw Error(`Capture blocked native mutation: ${command}`); }
      return fn(command, args);
    };
    let wrapped = wrap(invoke);
    Object.defineProperty(value, 'invoke', { configurable: false, get: () => wrapped, set: fn => { invoke = fn; wrapped = wrap(invoke); } });
    bridge = value;
  } });
  function assertSyntheticObject(value) { if (!value || typeof value !== 'object' || typeof value.invoke !== 'function') throw Error('Unexpected native bridge in capture'); }
}

const scenes = [
  { id: 'model-download-list', hash: 'catalog', stopped: true, captureViewport: { width: 1440, height: 1200 }, sample: 'Download catalog and synthetic resource estimates', action: async (page, zh) => {
    await page.locator('.model-download-list, [data-testid="model-download-list"]').first().waitFor();
    await page.locator('.model-download-model').first().waitFor();
  } },
  { id: 'model-download-detail', hash: 'catalog', stopped: true, captureViewport: { width: 1440, height: 1200 }, sample: 'Selected catalog model; synthetic resource assessment and disk capacity', action: async (page, zh) => {
    await page.locator('.model-download-list, [data-testid="model-download-list"]').first().waitFor();
    await page.locator('.model-download-model').nth(1).click();
    await page.locator('.model-download-detail, [data-testid="model-download-detail"]').first().waitFor();
    await page.getByTestId('resource-assessment').first().waitFor();
    await page.locator('.model-download-detail [data-testid="resource-assessment"][data-status="suggested"], .model-download-detail [data-testid="resource-assessment"][data-status="risk"]').first().waitFor();
  } },
  { id: 'api-verification', hash: 'connections', sample: 'Synthetic successful identity/model/readiness checks and one fixture SSE response', action: async (page, zh) => {
    await page.getByRole('button', { name: zh ? '接入 API' : 'Connect to the API', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: zh ? '开始验证' : 'Start verification', exact: true }).click();
    const passed = dialog.getByText(zh ? /本次验证通过/ : /This test passed/);
    await passed.waitFor();
    await passed.scrollIntoViewIfNeeded();
  } },
  { id: 'service-capabilities', hash: 'connections', sample: 'Synthetic running PID/startedAt/engine identity and checked metadata; supported/unsupported states reflect the fixture evidence', action: async (page, zh) => {
    const panel = page.locator('.daily-capabilities').filter({ visible: true }).first();
    await panel.locator('summary').click();
    await panel.getByRole('button', { name: zh ? '核验服务能力' : 'Check capabilities', exact: true }).click();
    await panel.locator('dl').waitFor();
    assert.match(await panel.innerText(), zh ? /文本聊天[\s\S]*可用/ : /Text chat[\s\S]*Available/);
    assert.doesNotMatch(await panel.innerText(), zh ? /旧结果已失效|未能确认|身份信息不足/ : /Previous results are invalid|identity is missing/);
    await panel.scrollIntoViewIfNeeded();
  } },
  { id: 'chat-execution', hash: 'chat', sample: 'Synthetic SSE response and separate local operation/service request/response IDs; no observer correlation', action: async (page, zh) => {
    await page.locator('#new-btn').click();
    await page.locator('#input').fill(zh ? '隔离示例：检查本次请求状态与标识。' : 'Isolated example: inspect this request status and identity.');
    await page.getByRole('button', { name: zh ? '发送' : 'Send', exact: true }).click();
    await page.getByText('STRATA_API_OK', { exact: true }).waitFor();
    const execution = page.locator('.chat-execution').last();
    await execution.locator('summary').click();
    assert.match(await execution.innerText(), /fixture-request/);
    assert.match(await execution.innerText(), /fixture-response/);
    assert.match(await execution.innerText(), /TTFT/);
    await execution.scrollIntoViewIfNeeded();
  } },
  { id: 'history-comparison', hash: 'benchmark', query: 'history', sample: 'Synthetic older historical values with missing identity and unknown test conditions; direct speedup conclusion is withheld', action: async (page, zh) => {
    await page.getByRole('radio', { name: zh ? '场景测试' : 'Scenario suite', exact: true }).click();
    await page.locator('.benchmark-history-disclosure').filter({ visible: true }).first().locator('summary').click();
    const panel = page.locator('.benchmark-history-comparison').filter({ visible: true }).first();
    await panel.waitFor();
    await panel.getByText(zh ? /条件尚不支持直接提速结论/ : /conditions do not support a direct speedup conclusion/).waitFor();
    assert.match(await panel.innerText(), zh ? /未核验/ : /Unverified/);
    await panel.scrollIntoViewIfNeeded();
  } },
  { id: 'startup-diagnostic', hash: 'overview', query: 'diagnostic', stopped: true, sample: 'Synthetic confirmed port-conflict diagnostic; stopped service remains stopped', action: async (page, zh) => {
    const panel = page.getByTestId('startup-diagnostic');
    await panel.waitFor();
    assert.match(await panel.innerText(), zh ? /监听端口被占用/ : /Listen port in use/);
    await panel.locator('summary').click();
  } },
  { id: 'api-usage', standalone: true, sample: 'Standalone real ApiUsagePage fixture; synthetic telemetry/statistics, not a whole App screenshot', action: async (page, zh, theme) => {
    await page.locator('.api-usage-page').waitFor();
    if (!zh) await page.getByRole('button', { name: '中 / EN', exact: true }).click();
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) {
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
    }
    await page.locator('.api-usage-tile').first().waitFor();
    await page.waitForFunction(() => (window.__apiFixture?.calls.filter(call => call.action === 'summary').length ?? 0) > 0);
  } },
];

async function sceneCase(scene, language, theme, viewport, capture) {
  const name = `${scene.id}.${language}${capture ? '' : `.${theme}.800`}`;
  const record = { name, scene: scene.id, language, theme, viewport, viewportReason: capture && scene.captureViewport ? 'Real taller viewport keeps complete resource guidance above the fixed download footer, without CSS/DOM edits.' : 'Default actual viewport for this scene.', sample: scene.sample, wholeApp: !scene.standalone, passed: false, pageErrors: [], consoleErrors: [], externalRequests: [], forbiddenNativeCalls: [] };
  const context = await browser.newContext({ viewport, deviceScaleFactor: capture ? 2 : 1, timezoneId: 'Asia/Shanghai', locale: language === 'zh' ? 'zh-CN' : 'en-US', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    record.externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.origin === origin.replace('http:', 'ws:')) socket.connectToServer();
    else { record.externalRequests.push(`WebSocket ${url.origin}${url.pathname}`); socket.close(); }
  });
  await context.addInitScript(nativeGuard);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => record.pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') record.consoleErrors.push(message.text()); });
  try {
    const params = new URLSearchParams({ version: currentVersion, language: language === 'zh' ? 'zh-CN' : 'en', theme });
    if (scene.stopped) params.set('stopped', '');
    if (scene.query) params.set(scene.query, '');
    await page.goto(scene.standalone ? `${origin}/api-usage-app.html` : `${origin}/daily-experience-app.html?${params}#${scene.hash}`, { waitUntil: 'networkidle' });
    if (!scene.standalone) {
      await page.locator('.desktop-app-frame').waitFor();
      assert.ok(await page.evaluate(version => !!window.__fixture && window.__fixture.currentVersion === version, currentVersion));
    }
    await scene.action(page, language === 'zh', theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    if (capture && scene.captureViewport) {
      const resource = page.locator('.model-download-detail [data-testid="resource-assessment"][data-status="suggested"], .model-download-detail [data-testid="resource-assessment"][data-status="risk"]').first();
      await resource.waitFor();
      await resource.scrollIntoViewIfNeeded();
      const resourceBox = await resource.boundingBox(), footerBox = await page.locator('.model-download-submit').boundingBox();
      assert.ok(resourceBox && footerBox, 'Resource guidance and download footer must be displayed');
      record.resourceVisibility = { top: resourceBox.y, bottom: resourceBox.y + resourceBox.height, footerTop: footerBox.y, fullyAboveFooter: resourceBox.y + resourceBox.height <= footerBox.y + 1 };
      assert.ok(record.resourceVisibility.top >= 0 && record.resourceVisibility.fullyAboveFooter, 'Complete resource guidance must be above the download footer');
    }
    if (scene.id === 'history-comparison') {
      const panel = page.locator('.benchmark-history-comparison').filter({ visible: true }).first();
      const panelBox = await panel.boundingBox();
      assert.ok(panelBox, 'The comparison card must be displayed');
      record.comparisonControlBounds = [];
      for (const label of language === 'zh' ? ['报告 A', '报告 B'] : ['Report A', 'Report B']) {
        const box = await panel.getByRole('combobox', { name: label, exact: true }).boundingBox();
        assert.ok(box, `The ${label} selector must be displayed`);
        const fits = box.x >= panelBox.x - 1 && box.x + box.width <= Math.min(panelBox.x + panelBox.width, viewport.width) + 1;
        record.comparisonControlBounds.push({ label, left: box.x, right: box.x + box.width, cardRight: panelBox.x + panelBox.width, viewportRight: viewport.width, fits });
        assert.ok(fits, `${label} selector must fit inside the comparison card and viewport`);
      }
    }
    record.pageLayout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, theme: document.documentElement.dataset.theme, language: document.documentElement.lang }));
    assert.equal(record.pageLayout.documentWidth > viewport.width, false, 'Horizontal document overflow');
    assert.equal(record.pageLayout.bodyWidth > viewport.width, false, 'Horizontal body overflow');
    assert.equal(record.pageLayout.theme, theme, 'Requested theme was not applied');
    record.forbiddenNativeCalls = await page.evaluate(() => window.__captureSafety.forbidden);
    record.nativeCallCount = await page.evaluate(() => window.__captureSafety.calls.length);
    assert.deepEqual(record.forbiddenNativeCalls, []);
    assert.deepEqual(record.externalRequests, []);
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.consoleErrors, []);
    const png = join(output, capture ? `${name}.png` : `qa/${name}.png`);
    await page.screenshot({ path: png, fullPage: false, animations: 'disabled', scale: 'device' });
    record.png = normalized(png);
    record.pngSha256 = digest(await readFile(png));
    record.passed = true;
    console.log(`PASS ${capture ? 'capture' : 'narrow QA'} ${name}`);
  } catch (error) {
    record.error = String(error);
    const failure = join(output, `qa/${name}.failure.png`);
    await page.screenshot({ path: failure, fullPage: false }).then(() => { record.failurePng = normalized(failure); }).catch(() => {});
    console.log(`FAIL ${name}: ${error}`);
  } finally {
    await context.close();
  }
  (capture ? manifest.captures : manifest.narrowQa).push(record);
  if (!record.passed) throw Error(`Capture/QA failed: ${name}. See failure PNG and manifest.`);
}

const convert = "import json,sys; from PIL import Image; a=Image.open(sys.argv[1]).convert('RGBA'); a.save(sys.argv[2],format='WEBP',lossless=True,quality=100,method=6,exact=True); b=Image.open(sys.argv[2]).convert('RGBA'); same=a.size==b.size and a.tobytes()==b.tobytes(); print(json.dumps({'width':a.width,'height':a.height,'pixelsEqual':same})); assert same, 'PNG/WebP pixels differ'";
try {
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: browserArguments });
  manifest.browser = { version: browser.version(), executablePath: browserExecutable, arguments: browserArguments, isolatedContext: true };
  if (probeHistory) {
    await sceneCase(scenes.find(scene => scene.id === 'history-comparison'), 'en', 'dark', { width: 800, height: 850 }, false);
  } else {
    for (const scene of scenes) for (const language of ['zh', 'en']) await sceneCase(scene, language, 'light', scene.captureViewport ?? { width: 1440, height: 960 }, true);
    for (const scene of scenes) for (const language of ['zh', 'en']) for (const theme of ['light', 'dark']) await sceneCase(scene, language, theme, { width: 800, height: 850 }, false);
  }
  assert.ok(manifest.captures.every(capture => capture.passed) && manifest.narrowQa.every(check => check.passed), 'Some capture or narrow QA cases failed. See manifest.json and failure PNGs.');
  for (const capture of manifest.captures) {
    const png = join(root, capture.png), webp = join(output, 'webp', `${capture.scene}.${capture.language}.webp`);
    capture.conversion = JSON.parse(run(python, ['-c', convert, png, webp]).trim());
    capture.webpSha256 = digest(await readFile(webp));
    capture.bytes = (await stat(webp)).size;
    capture.file = normalized(join(destination, `${capture.scene}.${capture.language}.webp`));
    console.log(`PASS lossless WebP ${capture.scene}.${capture.language}`);
  }
  const after = await snapshot();
  manifest.sourceProvenance.after = after;
  assert.equal(after.head, before.head, 'HEAD changed during capture');
  assert.equal(after.sourceTreeSha256, before.sourceTreeSha256, 'Production source changed during capture');
  assert.equal(after.helperTreeSha256, before.helperTreeSha256, 'Capture helpers changed during capture');
  await ready();
  manifest.sourceProvenance.sourceUnchangedDuringCapture = true;
  if (!probeHistory) {
    await mkdir(destination, { recursive: true });
    for (const capture of manifest.captures) await copyFile(join(output, 'webp', `${capture.scene}.${capture.language}.webp`), join(root, capture.file));
  }
  manifest.status = probeHistory ? 'probe-passed' : 'passed';
} catch (error) {
  manifest.status = 'failed';
  manifest.error = String(error);
  process.exitCode = 1;
} finally {
  if (!manifest.sourceProvenance.after) {
    try {
      const after = await snapshot();
      manifest.sourceProvenance.after = after;
      manifest.sourceProvenance.sourceUnchangedDuringCapture = after.head === before.head && after.sourceTreeSha256 === before.sourceTreeSha256 && after.helperTreeSha256 === before.helperTreeSha256;
    } catch (error) { manifest.sourceProvenance.snapshotError = String(error); }
  }
  const after = manifest.sourceProvenance.after;
  if (after) manifest.sourceProvenance.sourceUnchangedDuringCapture = after.head === before.head && after.sourceTreeSha256 === before.sourceTreeSha256 && after.helperTreeSha256 === before.helperTreeSha256;
  manifest.completedAt = new Date().toISOString();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (manifest.status === 'passed' && !probeHistory) {
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await browser?.close();
  await server.close();
}
console.log(`Capture status: ${manifest.status}; manifest: ${manifestPath}`);
