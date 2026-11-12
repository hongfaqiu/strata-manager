// One-shot preview for #225 (kept-settings task card) and #226 (one copy per "Add argument"), zh and en.
// Real App / StartupTuningPanel with synthetic native data. Output: STRATA_SCREENSHOT_DIR.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/tests/optimization');
const root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const port = 18767;
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } }, clearScreen: false, logLevel: 'warn' });
const output = process.env.STRATA_SCREENSHOT_DIR || resolve('/workspace/docs-preview/issues-225-226');
await mkdir(output, { recursive: true });
await server.listen();
const failures = [];
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page.on('pageerror', e => failures.push(e.message));
  const shot = async (name, locator) => { await page.mouse.move(0, 0); await page.waitForTimeout(300); await (locator ?? page).screenshot({ path: resolve(output, name), ...(locator ? {} : { fullPage: true }) }); };
  for (const lang of ['zh', 'en']) {
    const en = lang === 'en' ? '&en' : '';
    // #226: open the argument list, add --pcie-frac and --pool-workers (already in user_args) once each.
    await page.goto(`http://127.0.0.1:${port}/issues-225-226.html?panel${en}`);
    const list = page.locator('details.startup-arguments');
    await list.waitFor();
    await list.locator('summary').click();
    const rows = list.locator('.startup-argument-row');
    await rows.first().waitFor();
    const before = await rows.count();
    await shot(`226-1-args-before.${lang}.png`, list);
    const name = list.getByRole('combobox', { name: lang === 'zh' ? '新增参数名称' : 'New argument name' });
    const pick = async flag => { await name.fill(flag); await name.press('Escape'); };
    await pick('--stats');
    await list.locator('.startup-new-argument > button').click();
    await page.waitForFunction(n => document.querySelectorAll('details.startup-arguments .startup-argument-row').length === n, before + 1);
    const flagRows = flag => page.evaluate(f => [...document.querySelectorAll('details.startup-arguments .startup-argument-row')].filter(row => row.querySelector('input')?.value === f).length, flag);
    assert.equal(await flagRows('--stats'), 1, 'one --stats row');
    await shot(`226-2-args-after-add-one-row.${lang}.png`, list);
    await pick('--pool-workers');
    await list.getByRole('textbox', { name: lang === 'zh' ? '新增参数值 1' : 'New operand 1' }).fill('8');
    await list.getByTestId('startup-argument-exists').waitFor();
    assert.match(await list.locator('.startup-new-argument > button').innerText(), lang === 'zh' ? /改第 \d+ 项/ : /Update item \d+/);
    await shot(`226-3-existing-flag-updates-in-place.${lang}.png`, list);
    await list.locator('.startup-new-argument > button').click();
    await list.getByTestId('startup-argument-added').waitFor();
    assert.equal(await rows.count(), before + 1, 'updating --pool-workers adds no row');
    assert.equal(await flagRows('--pool-workers'), 1, 'one --pool-workers row');
    await shot(`226-4-existing-flag-updated.${lang}.png`, list);

    // #225: the task card on 任务与日志.
    await page.goto(`http://127.0.0.1:${port}/issues-225-226.html?${en.slice(1)}#tasks`);
    const card = page.locator('.task-row').first();
    await card.getByTestId('setup-kept-settings').waitFor();
    const text = await card.innerText();
    assert.match(text, lang === 'zh' ? /待你选择/ : /Needs your choice/);
    assert.match(text, /160K/); assert.match(text, /128K/);
    assert.doesNotMatch(text, /受管快照/);
    await shot(`225-1-task-card-kept-settings.${lang}.png`, page.locator('.task-list'));
    await page.goto(`http://127.0.0.1:${port}/issues-225-226.html?all${en}#tasks`);
    await page.locator('.task-row').first().getByTestId('setup-kept-settings').waitFor();
    await shot(`225-2-task-card-all-differences.${lang}.png`, page.locator('.task-row').first());
  }
} finally {
  await browser?.close();
  await server.close();
}
assert.deepEqual(failures, []);
console.log(`#225/#226 preview: ${output}`);
