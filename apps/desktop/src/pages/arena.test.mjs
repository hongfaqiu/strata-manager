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
  for (const file of ['./ArenaPage.tsx', './ArenaOfficialBoard.tsx', './arenaUpload.ts', '../onboarding/arenaPublic.ts', '../onboarding/OnboardingPage.tsx']) {
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

// The native arena_get forwards only allow-listed query keys and rejects anything else as
// arena_query_invalid. #35 added `sort` and `q` on the server and in the page but not here, so switching the
// sort made every leaderboard request fail and the page claimed the leaderboard was unreachable.
test('arena_get allows every query key the server accepts and the app sends', async () => {
  const rust = read('../../src-tauri/src/arena.rs');
  const list = /const QUERY_KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust);
  assert.ok(list, 'QUERY_KEYS found');
  const allowed = new Set([...list[1].matchAll(/"([^"]+)"/g)].map(match => match[1]));
  const { FILTER_KEYS } = await import('../../../../services/arena/src/stats.js');
  for (const key of ['group', ...FILTER_KEYS]) assert.ok(allowed.has(key), `/v1/leaderboard key ${key} is allowed`);
  const server = readFileSync(new URL('../../../../services/arena/src/index.js', import.meta.url), 'utf8');
  const recommend = server.slice(server.indexOf("path === '/v1/recommend'"), server.indexOf("throw new ArenaError(404, 'not_found');", server.indexOf("path === '/v1/recommend'")));
  const recommendKeys = new Set([...recommend.matchAll(/(?:p\.get|p\.has|n)\('([A-Za-z]+)'\)/g), ...recommend.matchAll(/\[([^\]]+)\]\) if/g)].flatMap(match => match[1].includes("'") ? [...match[1].matchAll(/'([A-Za-z]+)'/g)].map(m => m[1]) : [match[1]]));
  assert.ok(recommendKeys.has('scene') && recommendKeys.has('poolWorkers'), 'recommend keys parsed');
  for (const key of recommendKeys) assert.ok(allowed.has(key), `/v1/recommend key ${key} is allowed`);
});

test('only real network failures show "leaderboard unavailable"; app-side failures show the error and reset on retry', () => {
  const page = read('./ArenaPage.tsx'), strings = read('../ArenaStrings.ts');
  assert.doesNotMatch(page, /setOffline|catch \{ setOffline|\.catch\(\(\) => \{ if \(current\) set/, 'no failure is silently mapped to offline');
  assert.equal(page.split('setFailure(core.arenaFailure(error))').length - 1, 3, 'groups, leaderboard and recommend all classify their errors');
  assert.match(page, /failure\.kind === 'network' \? 'arenaOfflineTitle' : 'arenaErrorTitle'/);
  assert.match(page, /if \(failure\.kind === 'app'\) \{ setFacets\(\{\}\); setSort\('decode8k'\); \}/);
  for (const key of ['arenaErrorTitle', 'arenaErrorHint', 'arenaErrorCode']) {
    const line = strings.split('\n').find(l => l.trim().startsWith(key + ':'));
    assert.ok(line, key);
    assert.equal(line.match(/'(?:[^'\\]|\\.)*'/g).length, 10, `${key} has all 10 languages`);
  }
});

test('the official benchmark is the default board, the context board and recommendations stay as views', () => {
  const page = read('./ArenaPage.tsx');
  assert.match(page, /useState<'official' \| 'board' \| 'recommend'>\('official'\)/);
  for (const view of ["value: 'official'", "value: 'board'", "value: 'recommend'"]) assert.ok(page.includes(view), view);
  // A server without /v1/official falls back to the context board instead of an error page.
  assert.match(page, /setOfficialAvailable\(false\); setView\(previous => previous === 'official' \? 'board' : previous\)/);
  const board = read('./ArenaOfficialBoard.tsx');
  assert.match(board, /core\.arenaGet<Board>\('official', query\)/);
  assert.match(board, /useState<ArenaOfficialSort>\('chatDecode'\)/);
  assert.match(board, /className="is-ref"/);
  assert.match(board, /t\('arenaOfficialTag'\)/);
  assert.match(board, /ref\.source\.url/);
  const strings = read('../ArenaStrings.ts');
  for (const key of ['chatDecode', 'prefill4k', 'prefill16k', 'prefill32k', 'agentDecode', 'machines']) assert.match(strings, new RegExp(`arenaOffSort_${key}: \\['`));
  assert.match(strings, /arenaOfficialTag: \['官方'/);
});

test('official runs upload through the same consent-gated hook, after the local save', () => {
  const source = read('./OfficialBenchmarkPage.tsx');
  const save = source.indexOf('await core.saveStore(STORE_KEY, next);'), upload = source.indexOf('void arenaAfterBenchmark(report);');
  assert.ok(save > 0 && upload > save);
  assert.equal(source.split('arenaAfterBenchmark(').length - 1, 1);
  assert.match(read('./arenaUpload.ts'), /isOfficial\(report\) \? await arenaOfficialBuild\(report\) : await arenaBuild\(report\)/);
});
