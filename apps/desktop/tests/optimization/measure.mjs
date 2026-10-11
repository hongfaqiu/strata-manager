import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createLatestStoreWriter } from '../../src/storeWriteQueue.mjs';
const fixture = dirname(fileURLToPath(import.meta.url)), root = resolve(fixture, '../../../..');
const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
const { createServer } = await import(pathToFileURL(requireDesktop.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(requireDesktop.resolve('@vitejs/plugin-react')).href);
const { chromium } = await import(pathToFileURL(process.env.STRATA_PLAYWRIGHT_MODULE || requireDesktop.resolve('playwright')).href);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const imageBody = `data:image/png;base64,${Buffer.alloc(2_000_000, 65).toString('base64')}`;
const chats = [{ messages: [{ content: 'Synthetic attachment checkpoint', attachments: Array.from({ length: 10 }, (_, id) => ({ id: String(id), type: 'image', content: imageBody })) }] }];
const timings = []; let encodedBytes = 0;
for (let index = 0; index < 5; index++) { const start = performance.now(); const payload = JSON.stringify(chats); timings.push(performance.now() - start); encodedBytes = Buffer.byteLength(payload); }
let writes = 0; const writer = createLatestStoreWriter(async (_, value) => { JSON.stringify(value); writes++; }); writer.seed('conversations', chats);
const idleStart = performance.now(); for (let index = 0; index < 60; index++) { writer.stage('conversations', chats); await writer.flushAll(); }
const attachment = { rawImageBytes: 20_000_000, encodedBytes, stringifyMedianMs: median(timings), unchangedCheckpoints: 60, actualWrites: writes, unchangedQueueElapsedMs: performance.now() - idleStart, baselinePayloadBytesFor60UnchangedCheckpoints: encodedBytes * 60 };
assert.equal(writes, 0);
const server = await createServer({ configFile: false, root: fixture, plugins: [react()], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, clearScreen: false });
await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser; const renders = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.STRATA_BROWSER_EXECUTABLE || undefined });
  for (const count of [20, 100, 200]) {
    for (const mode of ['baseline', 'optimized']) {
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${origin}/performance.html?count=${count}&mode=${mode}`); await page.waitForFunction(() => window.__performance?.committed === 0);
      for (let tick = 1; tick <= 6; tick++) { await page.evaluate(() => window.__performance.step()); await page.waitForFunction(value => window.__performance.committed === value, tick); }
      const result = await page.evaluate(() => ({ durations: window.__performance.durations, chars: window.__performance.chars }));
      assert.deepEqual(errors, []); assert.equal(result.durations.length, 6); assert.match(await page.locator('.st-msg--assistant').last().innerText(), /Delta 6/);
      renders.push({ historicalMessages: count, mode, charsPerMessage: result.chars, updateDurationsMs: result.durations, updateMedianMs: median(result.durations.slice(1)) });
      console.log(`${count} ${mode}: ${renders.at(-1).updateMedianMs.toFixed(2)} ms`); await context.close();
    }
  }
} finally { await browser?.close(); await server.close(); }
const result = { methodology: 'Synthetic data only. Headless Chromium, React development Profiler actualDuration; baseline recreates pre-change callbacks, optimized keeps historical props. 6 updates, discard first warm-up. Not production FPS or actual IPC/disk throughput.', node: process.version, attachment, renders };
await mkdir(resolve(root, 'output/optimization-verification'), { recursive: true });
await writeFile(resolve(root, 'output/optimization-verification/performance-results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(attachment));
