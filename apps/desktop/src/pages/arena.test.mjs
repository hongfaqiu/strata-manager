import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('finished benchmarks hand their report to the Arena uploader only after the local save', () => {
  for (const file of ['./ContextBenchmarkPage.tsx', './ScenarioBenchmarkPage.tsx']) {
    const source = read(file);
    const save = source.indexOf('await core.saveStore(STORE_KEY, next);');
    const upload = source.indexOf('void arenaAfterBenchmark(report);');
    assert.ok(save > 0 && upload > save, `${file} uploads after saving`);
    assert.equal(source.split('arenaAfterBenchmark(').length - 1, 1, `${file} has a single upload hook`);
  }
  const uploader = read('./arenaUpload.ts');
  assert.match(uploader, /status\.consented && status\.autoUpload|!status\.consented \|\| !status\.autoUpload/);
  assert.match(uploader, /catch \{/);
});

test('the Arena UI never reaches the network itself and the CSP stays IPC-only', () => {
  for (const file of ['./ArenaPage.tsx', './arenaUpload.ts', '../onboarding/arenaPublic.ts', '../onboarding/OnboardingPage.tsx']) {
    const source = read(file);
    assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|https?:\/\//, `${file} uses the native bridge only`);
  }
  const csp = JSON.parse(read('../../src-tauri/tauri.conf.json')).app.security.csp;
  assert.match(csp, /connect-src ipc: http:\/\/ipc\.localhost;/);
});

test('the leaderboard is a Benchmark tab and keeps the existing modes', () => {
  const page = read('./BenchmarkPage.tsx');
  for (const mode of ["value: 'context'", "value: 'scenario'", "value: 'arena'"]) assert.ok(page.includes(mode), mode);
  assert.match(page, /<ArenaPage language=\{props\.language\} active=\{mode === 'arena'\}\/>/);
});

test('builds without the CI app key show the board read-only and never offer consent', () => {
  const page = read('./ArenaPage.tsx');
  assert.match(page, /const showConsent = desktop && status && status\.uploadAvailable && !status\.consented/);
  assert.match(page, /disabled=\{busy === 'consent' \|\| !status\.uploadAvailable\}/);
  assert.match(page, /t\('arenaReadOnly'\)/);
  assert.doesNotMatch(page, /installId/, 'the preview shows no install identifier');
});

test('uploads say whether the run evidence verified, and the hint explains immediate counting', () => {
  const page = read('./ArenaPage.tsx'), strings = read('../ArenaStrings.ts');
  assert.match(page, /entry\.detail === 'verified' \|\| entry\.detail === 'pending'/);
  assert.match(page, /t\('arenaVerifiedHint'\)/);
  for (const key of ['arenaVerifiedHint', 'arenaLog_verified', 'arenaLog_pending']) {
    const line = strings.split('\n').find(l => l.trim().startsWith(key + ':'));
    assert.ok(line, key);
    assert.equal(line.match(/'(?:[^'\\]|\\.)*'/g).length, 10, `${key} has all 10 languages`);
  }
  assert.doesNotMatch(strings, /2 天内上传 3 次|3 uploads over at least 2 days/, 'no probation wording left');
});

test('the leaderboard adds facet filters and a sort switch while keeping the hardware scope', () => {
  const page = read('./ArenaPage.tsx'), strings = read('../ArenaStrings.ts');
  assert.match(page, /\{ value: 'gpu', label: gpuLabel\(myGpu\.name\) \}, \{ value: 'vram', label: t\('arenaVramTier'/, 'my GPU / my VRAM tier / all scope stays');
  assert.match(page, /core\.arenaLeaderboardQuery\(group, activeFilters, sort\)/, 'filters and sort reach the server');
  assert.match(page, /core\.arenaApplyFilters\(board\?\.rows \?\? \[\], activeFilters, sort\)/, 'and are applied locally for servers that ignore them');
  assert.match(page, /const FACET_ORDER: readonly ArenaFacet\[\] = \['vram', 'ram', 'ctx', 'kv', 'parallel', 'gpuCount', 'expertCache'\]/);
  assert.match(page, /\(facetOptions\[facet\]\?\.length \?\? 0\) > 1/, 'only facets with a real choice are offered');
  assert.match(page, /core\.ARENA_SORTS\.map/);
  assert.match(page, /useEffect\(\(\) => \{ setFacets\(\{\}\); \}, \[group\]\)/, 'switching model + quant clears the filters');
  for (const key of ['arenaFilters', 'arenaFilterAny', 'arenaFilterGpu', 'arenaFilterVram', 'arenaFilterRam', 'arenaFilterReset', 'arenaFilterShown', 'arenaNoMatch', 'arenaNoMatchHint', 'arenaSort', 'arenaSort_decode8k', 'arenaSort_decode128k', 'arenaSort_prefill', 'arenaSort_machines']) {
    const line = strings.split('\n').find(l => l.trim().startsWith(key + ':'));
    assert.ok(line, key);
    assert.equal(line.match(/'(?:[^'\\]|\\.)*'/g).length, 10, `${key} has all 10 languages`);
  }
});
