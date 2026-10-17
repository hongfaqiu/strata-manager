import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { leaderboardPages, renderLeaderboardPage } from './render-website-leaderboard.mjs';
import { FACETS, SORTS } from '../services/arena/src/stats.js';

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
