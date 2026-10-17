/**
 * Documentation screenshots for the getting-started guide, the in-app Benchmark leaderboard and the
 * old-version configuration cleanup dialog. Every scene runs the real App against the isolated test
 * fixtures (synthetic native IO, no network); nothing touches a real Strata, model or account.
 *
 *   node scripts/capture-feature-screenshots.mjs
 *   env: STRATA_PLAYWRIGHT_MODULE, STRATA_BROWSER_EXECUTABLE, STRATA_PYTHON_EXECUTABLE
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'apps/desktop/tests/optimization');
const output = join(root, 'output/playwright/feature-screenshots');
const destination = join(root, 'docs/screenshots');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const playwrightModule = process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright');
const pw = await import(pathToFileURL(playwrightModule).href);
const chromium = pw.chromium ?? pw.default.chromium;
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const python = process.env.STRATA_PYTHON_EXECUTABLE || 'python3';
const version = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const arenaPreview = join(root, 'scripts/screenshot-fixtures/arena-preview.js');

// Synthetic public speeds for the guide's model step (read-only Arena data).
const guideArena = { groups: { computedAt: Date.now() - 18 * 60000, machines: 128, runs: 611, groups: [
  { group: 'swift:IQ3_S', family: 'swift', quant: 'IQ3_S', machines: 46, bestDecode: 41.6, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 18 }, { gpu: 'RTX 3090', vramGB: 24, machines: 13 }] },
  { group: 'qwen:IQ3_S', family: 'qwen', quant: 'IQ3_S', machines: 31, bestDecode: 37.9, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 14 }] },
  { group: 'coder:IQ1_M', family: 'coder', quant: 'IQ1_M', machines: 12, bestDecode: 35.4, gpus: [{ gpu: 'RTX 4090', vramGB: 24, machines: 7 }] },
] }, tiers: { 'swift:IQ3_S': 38.9, 'qwen:IQ3_S': 34.6, 'coder:IQ1_M': 33.1 } };

const scenes = [
  { id: 'onboarding', url: 'onboarding-app.html?state=model#guide', guideArena: true, sample: 'First-run guide, model step: synthetic RTX 4090 machine and read-only leaderboard speeds', action: async page => {
    await page.locator('[data-testid="onboarding"][data-step="model"]').waitFor();
    await page.waitForTimeout(800);
  } },
  { id: 'arena', url: 'daily-experience-app.html?version=VERSION&language=LANG&theme=light#benchmark', arena: true, sample: 'Benchmark leaderboard tab with synthetic groups, rows and recommendations served by the mocked native arena_get', action: async (page, zh) => {
    await page.locator('.desktop-app-frame').waitFor();
    await page.getByRole('radio', { name: zh ? '排行榜' : 'Leaderboard', exact: true }).click();
    await page.locator('.benchmark-workspace [hidden]').first().waitFor({ state: 'attached' });
    await page.waitForTimeout(1500);
  } },
  { id: 'config-cleanup', url: 'multi-version-app.html?version=VERSION#models', sample: 'Strata 0.1.38–0.1.44 side by side sharing one Strata-data folder; cleanup dialog lists old-version configurations only (read-only plan)', action: async (page, zh) => {
    await page.getByRole('button', { name: zh ? '清理旧版本配置' : 'Clean up old-version configurations' }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(800);
  } },
];

await mkdir(join(output, 'png'), { recursive: true });
await mkdir(join(output, 'webp'), { recursive: true });
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root] } }, clearScreen: false });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
const captures = [];
const selected = process.env.STRATA_CAPTURE_SCENES?.split(',');
try {
  for (const scene of scenes) for (const language of ['zh', 'en']) {
    if (selected && !selected.includes(scene.id)) continue;
    const zh = language === 'zh';
    const record = { file: `${scene.id}.${language}.webp`, scene: scene.id, language, sample: scene.sample, errors: [], consoleErrors: [], externalRequests: [], passed: false };
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, locale: zh ? 'zh-CN' : 'en-US', colorScheme: 'light', timezoneId: 'Asia/Shanghai' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); record.externalRequests.push(url.href); return route.abort(); });
    await context.addInitScript(lang => {
      // Apply the requested interface language to whichever fixture store is installed.
      let value;
      Object.defineProperty(window, '__fixture', { configurable: true, get: () => value, set: next => {
        const settings = next?.store?.settings ?? next?.state?.store?.settings;
        if (settings) { settings.language = lang; if ('languagePreference' in settings) settings.languagePreference = lang; }
        value = next;
      } });
    }, zh ? 'zh-CN' : 'en');
    if (scene.arena) await context.addInitScript({ path: arenaPreview });
    if (scene.guideArena) await context.addInitScript(mock => { window.__arenaMock = mock; }, guideArena);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => record.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') record.consoleErrors.push(message.text()); });
    try {
      await page.goto(`${origin}/${scene.url.replace('VERSION', version).replace('LANG', zh ? 'zh-CN' : 'en')}`, { waitUntil: 'networkidle' });
      await scene.action(page, zh);
      await page.mouse.move(2, 2);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      record.layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, language: document.documentElement.lang }));
      assert.equal(record.layout.documentWidth, record.layout.width, 'Horizontal overflow');
      for (const key of ['errors', 'consoleErrors', 'externalRequests']) assert.deepEqual(record[key], [], `${scene.id}.${language}: ${key}`);
      const png = join(output, 'png', `${scene.id}.${language}.png`);
      await page.screenshot({ path: png, animations: 'disabled', scale: 'device' });
      record.png = relative(root, png).replaceAll('\\', '/'); record.pngSha256 = hash(await readFile(png)); record.passed = true;
      console.log(`PASS ${scene.id}.${language}`);
    } catch (error) {
      record.failure = String(error.stack || error);
      await page.screenshot({ path: join(output, `${scene.id}.${language}.failure.png`) }).catch(() => {});
      throw error;
    } finally { captures.push(record); await context.close(); }
  }
  const convert = "import json,sys\nfrom PIL import Image\nfor src,dst in json.load(sys.stdin):\n a=Image.open(src).convert('RGBA'); a.save(dst,format='WEBP',lossless=True,quality=100,method=6,exact=True); b=Image.open(dst).convert('RGBA'); assert a.size==b.size and a.tobytes()==b.tobytes(); print(json.dumps({'width':a.size[0],'height':a.size[1]}))";
  const pairs = captures.map(item => [join(root, item.png), join(output, 'webp', item.file)]);
  const result = spawnSync(python, ['-c', convert], { input: JSON.stringify(pairs), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const sizes = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  for (let i = 0; i < captures.length; i++) {
    assert.deepEqual(sizes[i], { width: 2880, height: 1920 });
    Object.assign(captures[i], sizes[i], { pixelEquality: true, sha256: hash(await readFile(pairs[i][1])) });
    await copyFile(pairs[i][1], join(destination, captures[i].file));
  }
  const manifestPath = join(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const previous = manifest.featureScreens?.screens ?? [];
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  manifest.featureScreens = { capturedAt: new Date().toISOString(), appVersion: version, sourceHead: head, browserVersion: browser.version(),
    source: 'Real App components via the isolated test fixtures (onboarding-app.html, daily-experience-app.html, multi-version-app.html) plus scripts/screenshot-fixtures/arena-preview.js',
    scope: 'Synthetic in-memory native data and leaderboard values. No real model, Strata runtime, network, account or file mutation.',
    conversion: 'Lossless WebP with decoded RGBA equality',
    screens: [...previous.filter(item => !captures.some(updated => updated.file === item.file)), ...captures] };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ success: true, captures: captures.length }));
} finally { await browser.close(); await server.close(); }
