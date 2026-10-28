import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { leaderboardPages, renderLeaderboardPage } from './render-website-leaderboard.mjs';
import { FACETS, OFFICIAL_SORTS, SORTS } from '../services/arena/src/stats.js';
import { fetchArenaSnapshot } from './render-website-leaderboard.mjs';

const script = readFileSync(new URL('../website/leaderboard.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../website/leaderboard.css', import.meta.url), 'utf8');

test('the leaderboard header keeps the website and changelog links on narrow screens', () => {
  for (const entry of leaderboardPages) {
    const html = renderLeaderboardPage(entry);
    assert.doesNotMatch(html, /lb-hide-narrow/);
    assert.match(html, /class="header-action" href="\.\/[^"]*">(返回官网|Website)</);
    assert.match(html, /class="header-action" href="docs\/changelog(\.en)?\.html">(更新日志|Changelog)</);
  }
  assert.doesNotMatch(css, /lb-hide-narrow/);
});

test('website filters and sorts mirror the API and live in a shareable URL hash', () => {
  const keys = src => [...src.matchAll(/(\w+): r =>/g)].map(m => m[1]);
  const sorts = script.match(/const SORTS = \{([^\n]+)\};/)[1], facets = script.match(/const FACETS = \{([^\n]+)\};/)[1];
  assert.deepEqual(keys(sorts), Object.keys(SORTS), 'same sort keys as services/arena');
  assert.deepEqual(keys(facets), Object.keys(FACETS), 'same facets as services/arena');
  assert.match(script, /new URLSearchParams\(raw\)/, 'filters are read from the hash');
  assert.match(script, /if \(!raw\.includes\('='\)\) \{ state\.group = decodeURIComponent\(raw\); return; \}/, 'older #model:quant links still open their group');
  assert.match(script, /history\.replaceState\(null, '', '#' \+/);
  assert.match(script, /\(await snapshot\(\)\)\?\.boards\?\.\[group\]/, 'the build-time snapshot still backs the page');
  assert.match(script, /opts\[k\]\.length > 1/, 'only facets with a real choice are offered');
});

test('the official benchmark is the default board; the context board stays one switch away', () => {
  const keys = src => [...src.matchAll(/(\w+): r =>/g)].map(m => m[1]);
  const sorts = script.match(/const OFFICIAL_SORTS = \{([^\n]+)\};/)[1];
  assert.deepEqual(keys(sorts), Object.keys(OFFICIAL_SORTS), 'same official sort keys as services/arena');
  assert.match(script, /mode: 'official'/, 'no hash opens the official board');
  assert.match(script, /if \(!raw\) return;\n\s+state\.mode = 'context';/, 'hashes from before the official board keep opening the context board');
  assert.match(script, /p\.set\('board', state\.mode\)/);
  assert.match(script, /\$\{api\}\/v1\/official/);
  assert.match(script, /class="is-ref"/, 'published numbers render as reference rows');
  assert.match(script, /l\.ref\.source\.url/, 'with their source link');
  assert.match(css, /\.lb-obars > li\.is-ref/);
});

test('the snapshot also captures the official board, and survives servers without it', async () => {
  const answers = {
    '/v1/groups': { groups: [{ group: 'qwen:IQ3_S' }] }, '/v1/leaderboard?group=qwen%3AIQ3_S': { rows: [] },
    '/v1/official': { group: 'qwen:IQ3_S', groups: [{ group: 'qwen:IQ3_S' }, { group: 'qwen:NVFP4-QAD' }], rows: [], references: [{ id: 'a' }] },
    '/v1/official?group=qwen%3ANVFP4-QAD': { group: 'qwen:NVFP4-QAD', groups: [], rows: [], references: [{ id: 'b' }] },
  };
  const fetchImpl = (missing = []) => async url => { const path = url.replace('https://x', ''); const body = missing.includes(path) ? undefined : answers[path];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body }; };
  const snap = await fetchArenaSnapshot({ api: 'https://x', fetchImpl: fetchImpl() });
  assert.equal(snap.official.index.group, 'qwen:IQ3_S');
  assert.deepEqual(Object.keys(snap.official.boards), ['qwen:IQ3_S', 'qwen:NVFP4-QAD']);
  assert.equal(snap.official.boards['qwen:NVFP4-QAD'].references[0].id, 'b');
  const old = await fetchArenaSnapshot({ api: 'https://x', fetchImpl: fetchImpl(['/v1/official']) });
  assert.equal(old.official, undefined);
  assert.ok(old.boards['qwen:IQ3_S']);
});
