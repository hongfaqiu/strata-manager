import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentSeo, escapeHtml as escape, homePage, standalonePages } from './website-seo.mjs';

// The Benchmark Arena leaderboard: one static shell per language. The same Worker serves the site and
// the public read-only API, so the page reads /v1/* from its own origin at runtime, with a JSON snapshot
// (refreshed at build time from the API host when reachable) as fallback.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ARENA_API = 'https://arena.cosfoc.com';
export const leaderboardPages = standalonePages.filter((entry) => entry.key === 'leaderboard');
const copy = {
  zh: { title: 'Benchmark 排行榜', description: 'Strata Manager 用户自愿上传的 Benchmark 汇总：默认按官方 strata_bench.py 跑法的对话解码速度排名，并对照官方公布数字；同一模型、同一量化内比较不同硬件与启动参数。', home: '返回官网', docs: '文档中心', changelog: '更新日志', other: 'English', theme: '主题', skip: '跳转到正文', privacy: '隐私说明', loading: '正在读取排行榜…', foot: 'Strata 运行环境与本地模型服务，一站管理。' },
  en: { title: 'Benchmark leaderboard', description: 'Benchmarks voluntarily shared by Strata Manager users, ranked by default on chat decode measured the official strata_bench.py way next to the published numbers; within the same model and quantization, compare hardware and launch parameters.', home: 'Website', docs: 'Documentation', changelog: 'Changelog', other: '简体中文', theme: 'Theme', skip: 'Skip to content', privacy: 'Privacy', loading: 'Loading leaderboard…', foot: 'Strata runtimes and local model services, in one workspace.' },
};
export function renderLeaderboardPage(entry) {
  const en = entry.lang === 'en', c = copy[entry.lang];
  const alternate = leaderboardPages.find((item) => item.lang !== entry.lang);
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#f7f6f2" id="theme-color">
  <title>${escape(c.title)} · Strata Manager</title>
  <meta name="description" content="${escape(c.description)}">
  ${documentSeo({ title: `${c.title} · Strata Manager`, description: c.description, page: entry.page, lang: entry.lang, alternates: leaderboardPages })}
  <link rel="icon" href="assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="docs.css">
  <link rel="stylesheet" href="leaderboard.css">
  <script src="docs.js"></script>
  <script src="leaderboard.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#content">${c.skip}</a>
  <header class="doc-header">
    <a class="doc-brand" href="./${homePage(entry.lang)}"><img src="assets/icon.svg" width="32" height="32" alt=""><span>Strata <span class="brand-subtitle">Manager</span></span></a>
    <nav class="header-actions" aria-label="${en ? 'Page controls' : '页面操作'}">
      <a class="header-action" href="./${homePage(entry.lang)}">${c.home}</a>
      <a class="header-action" href="docs/${en ? 'changelog.en.html' : 'changelog.html'}">${c.changelog}</a>
      <a class="header-action" href="${alternate.page}" hreflang="${alternate.lang === 'zh' ? 'zh-CN' : 'en'}" lang="${alternate.lang === 'zh' ? 'zh-CN' : 'en'}">${c.other}</a>
      <button class="header-action" id="doc-theme" type="button">${c.theme}</button>
    </nav>
  </header>
  <main id="content" class="lb-main" data-api="" data-snapshot="arena-snapshot.json" data-privacy="docs/${en ? 'arena-privacy.en.html' : 'arena-privacy.html'}">
    <section class="lb-hero">
      <h1>${c.title}</h1>
      <p>${en ? 'Only the same model and the same quantization are compared. Ranked by the official benchmark (chat decode) by default, with the maintainers’ published numbers as Official rows; switch to prefill or to the context runs (8K decode).' : '只在同一模型、同一量化内比较。默认按官方基准的对话解码排名，维护者公布的数字以「官方」行对照；可切换预填充或上下文测速（8K 解码）。'}</p>
      <div class="lb-stats" id="lb-stats" aria-live="polite"></div>
    </section>
    <div id="lb-root" class="lb-root"><p class="lb-status">${c.loading}</p></div>
    <noscript><p class="lb-status">${en ? 'The leaderboard needs JavaScript to load the latest data.' : '排行榜需要 JavaScript 读取最新数据。'}</p></noscript>
    <footer class="doc-footer"><a href="docs/${en ? 'arena-privacy.en.html' : 'arena-privacy.html'}">${c.privacy}</a><span>${c.foot}</span><a href="https://github.com/hongfaqiu/strata-manager">GitHub</a></footer>
  </main>
</body>
</html>
`;
}
const emptySnapshot = { capturedAt: null, groups: { computedAt: null, machines: 0, runs: 0, groups: [] }, boards: {} };
/** Fetch the current aggregates for the static fallback. Network trouble keeps the committed snapshot. */
export async function fetchArenaSnapshot({ api = ARENA_API, fetchImpl = fetch, timeoutMs = 8000, limit = 24 } = {}) {
  const get = async (path) => {
    const response = await fetchImpl(api + path, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const groups = await get('/v1/groups');
  if (!Array.isArray(groups?.groups)) throw new Error('groups: unexpected shape');
  const boards = {};
  for (const item of groups.groups.slice(0, limit)) boards[item.group] = await get(`/v1/leaderboard?group=${encodeURIComponent(item.group)}`);
  // The official board (/v1/official) is optional: servers that predate it keep the snapshot as before.
  let official = null;
  try {
    const index = await get('/v1/official');
    if (Array.isArray(index?.groups)) {
      const officialBoards = {};
      for (const item of index.groups.slice(0, limit)) officialBoards[item.group] = item.group === index.group ? index : await get(`/v1/official?group=${encodeURIComponent(item.group)}`);
      official = { index, boards: officialBoards };
    }
  } catch { official = null; }
  return { capturedAt: Date.now(), groups, boards, ...(official ? { official } : {}) };
}
export async function renderLeaderboardPages(output, { refresh = !process.env.STRATA_WEBSITE_OFFLINE } = {}) {
  for (const entry of leaderboardPages) await writeFile(join(output, entry.page), renderLeaderboardPage(entry));
  const committed = await readFile(join(root, 'website', 'arena-snapshot.json'), 'utf8').then(JSON.parse).catch(() => emptySnapshot);
  let snapshot = committed, source = 'committed';
  if (refresh) {
    try { snapshot = await fetchArenaSnapshot(); source = 'live'; } catch (error) { source = `committed (${error.message})`; }
  }
  await writeFile(join(output, 'arena-snapshot.json'), JSON.stringify(snapshot) + '\n');
  return { pages: leaderboardPages.length, source };
}
