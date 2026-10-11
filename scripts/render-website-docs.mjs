import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { documentSeo, homePage, site } from './website-seo.mjs';
import { localizedReleaseNotes } from '../apps/desktop/src/updateReleaseNotes.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const [{ default: React }, { renderToStaticMarkup }, { default: Markdown, defaultUrlTransform }, { default: remarkGfm }] = await Promise.all([
  import(pathToFileURL(requireDesktop.resolve('react')).href),
  import(pathToFileURL(requireDesktop.resolve('react-dom/server')).href),
  import(pathToFileURL(requireDesktop.resolve('react-markdown')).href),
  import(pathToFileURL(requireDesktop.resolve('remark-gfm')).href),
]);
const h = React.createElement;
const repository = 'https://github.com/hongfaqiu/strata-manager/blob/main/';

export const documents = [
  { source: 'docs/README.md', page: 'docs/index.html', lang: 'zh', key: 'index', label: '文档中心' },
  { source: 'docs/README.en.md', page: 'docs/index.en.html', lang: 'en', key: 'index', label: 'Documentation' },
  { source: 'docs/SYSTEM.md', page: 'docs/system.html', lang: 'zh', key: 'system', label: '系统说明' },
  { source: 'docs/SYSTEM.en.md', page: 'docs/system.en.html', lang: 'en', key: 'system', label: 'System explanation' },
  { source: 'docs/USER_GUIDE.md', page: 'docs/user-guide.html', lang: 'zh', key: 'guide', label: '使用指南' },
  { source: 'docs/USER_GUIDE.en.md', page: 'docs/user-guide.en.html', lang: 'en', key: 'guide', label: 'User guide' },
  { source: 'docs/DOWNLOAD.md', page: 'docs/download.html', lang: 'zh', key: 'download', label: '下载与体验' },
  { source: 'docs/DOWNLOAD.en.md', page: 'docs/download.en.html', lang: 'en', key: 'download', label: 'Download and try' },
  { source: 'CHANGELOG.md', page: 'docs/changelog.html', lang: 'zh', key: 'changelog', label: '更新日志', changelog: true },
  { source: 'CHANGELOG.md', page: 'docs/changelog.en.html', lang: 'en', key: 'changelog', label: 'Changelog', changelog: true },
  { source: 'docs/TROUBLESHOOTING.md', page: 'docs/troubleshooting.html', lang: 'zh', key: 'troubleshooting', label: '故障排查' },
  { source: 'docs/TROUBLESHOOTING.en.md', page: 'docs/troubleshooting.en.html', lang: 'en', key: 'troubleshooting', label: 'Troubleshooting' },
  { source: 'THIRD_PARTY_NOTICES.md', page: 'docs/third-party-notices.html', lang: 'zh', key: 'notices', label: '第三方声明', languageLabel: '中文 / English 许可原文' },
  { source: 'LICENSE', page: 'docs/license.html', lang: 'en', key: 'license', label: 'MIT license', languageLabel: 'English original', plain: true },
  { source: 'apps/desktop/public/licenses/outfit-OFL.txt', page: 'docs/outfit-license.html', lang: 'en', key: 'outfit', label: 'Outfit font license', languageLabel: 'English original', plain: true },
];
const bySource = new Map(documents.map((entry) => [entry.source, documents.filter((item) => item.source === entry.source)]));
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
const relativePage = (from, to) => posix.relative(posix.dirname(from), to) || posix.basename(to);

// Match GitHub's heading convention: punctuation removed, lower case, spaces to hyphens.
export function headingSlug(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\-_\s]/gu, '').replace(/\s/g, '-');
}

function nodeText(node) {
  if (typeof node.value === 'string') return node.type === 'html' ? '' : node.value;
  if (node.type === 'image') return node.alt || '';
  return (node.children || []).map(nodeText).join('');
}

function documentHeadings(headings) {
  return () => (tree) => {
    const used = new Set();
    function visit(node) {
      if (node.type === 'html') {
        // Preserve explicit named anchors without enabling arbitrary raw HTML.
        const match = node.value.match(/^\s*<a\s+(?:id|name)=["']([\p{L}\p{N}_.:-]+)["']\s*>\s*(?:<\/a>\s*)?$/u);
        if (match) {
          node.type = 'link';
          delete node.value;
          node.children = [];
          node.url = `#${match[1]}`;
          node.data = { hName: 'a', hProperties: { id: match[1] } };
          used.add(match[1]);
        }
      }
      if (node.type === 'heading') {
        const text = nodeText(node);
        const base = headingSlug(text);
        let slug = base;
        let number = 0;
        while (used.has(slug)) slug = `${base}-${++number}`;
        used.add(slug);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug } };
        headings.push({ depth: node.depth, text, id: slug });
      }
      for (const child of node.children || []) visit(child);
    }
    visit(tree);
  };
}

export function rewriteDocumentUrl(value, source, outputPage) {
  const safe = defaultUrlTransform(value);
  if (!safe || safe.startsWith('#')) return safe;
  let local = safe;
  if (local.startsWith(repository)) local = `/${local.slice(repository.length)}`;
  else if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(local)) return safe;
  const parts = local.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const pathname = decodeURIComponent(parts[1]);
  const suffix = (parts[2] || '') + (parts[3] || '');
  const target = posix.resolve('/', posix.dirname(source), pathname).slice(1);
  const language = documents.find((entry) => entry.page === outputPage)?.lang || 'zh';
  const targets = bySource.get(target);
  const document = targets?.find((entry) => entry.lang === language) || targets?.[0];
  if (document) return relativePage(outputPage, document.page) + suffix;
  if (target === 'README.md' || target === 'README.en.md' || target === 'README.zh-CN.md') {
    const lang = target === 'README.zh-CN.md' ? 'zh' : 'en';
    // The landing page and repository README have different section names.
    // Preserve README-specific anchors at their original source.
    if (parts[3]) return repository + encodePath(target) + suffix;
    return relativePage(outputPage, homePage(lang) || './') + '/';
  }
  if (target.startsWith('docs/screenshots/')) {
    return relativePage(outputPage, target.replace('docs/screenshots/', 'assets/screenshots/')) + suffix;
  }
  if (target === 'assets/icon.svg') return relativePage(outputPage, target) + suffix;
  return repository + encodePath(target) + suffix;
}

export function renderMarkdownContent(markdown, source, outputPage) {
  const headings = [];
  const html = renderToStaticMarkup(h(Markdown, {
    remarkPlugins: [remarkGfm, documentHeadings(headings)],
    skipHtml: true,
    urlTransform: (url) => rewriteDocumentUrl(url, source, outputPage),
    components: {
      table: ({ node, ...props }) => h('div', { className: 'table-scroll', tabIndex: 0 }, h('table', props)),
      img: ({ node, ...props }) => h('img', { ...props, loading: 'lazy', decoding: 'async' }),
    },
  }, markdown));
  return { html, headings };
}

export function renderChangelog(markdown, language) {
  const english = language === 'en';
  const versions = [...markdown.matchAll(/^##[ \t]+\[([^\]]+)\]([^\r\n]*)\r?$/gm)];
  if (!versions.length) throw new Error('CHANGELOG.md requires version sections.');
  const introduction = english
    ? '# Changelog\n\nChanges by version. **Unreleased changes are not included in publicly available installers.** Package availability is established by [GitHub Releases](https://github.com/hongfaqiu/strata-manager/releases).'
    : '# 更新日志\n\n按版本记录功能与修复。**未发布内容尚未包含在公开安装包中。** 安装包是否可用，以 [GitHub 发布页](https://github.com/hongfaqiu/strata-manager/releases)为准。';
  return introduction + '\n\n' + versions.map((version, index) => {
    const section = markdown.slice(version.index + version[0].length, versions[index + 1]?.index ?? markdown.length);
    // Moving all pending notes into a release leaves a valid empty placeholder.
    if (version[1] === 'Unreleased' && !section.replace(/^###[ \t]+(?:中文|English)[ \t]*\r?$/gm, '').trim()) return null;
    const notes = localizedReleaseNotes(section, english ? 'en' : 'zh-CN');
    if (!notes) throw new Error(`Changelog ${version[1]} requires nonempty ${language} notes.`);
    const label = version[1] === 'Unreleased' ? (english ? 'Unreleased' : '未发布') : version[1];
    const suffix = english ? version[2] : version[2].replace(/Unreleased/g, '尚未发布').replace(/Unpublished/g, '未公开发布');
    return `## ${label}${suffix}\n\n${notes}`;
  }).filter(Boolean).join('\n\n') + '\n';
}

function renderDocument(entry, markdown) {
  const en = entry.lang === 'en';
  const alternate = documents.find((item) => item.key === entry.key && item.lang !== entry.lang);
  const chrome = en ? {
    home: 'Website', index: 'Documentation', contents: 'On this page', source: 'Source file', original: 'View on GitHub', theme: 'Switch theme', skip: 'Skip to content', language: 'Document language', nav: 'Documentation navigation', foot: 'Strata runtimes and local model services, in one workspace.',
  } : {
    home: '返回官网', index: '文档中心', contents: '本页目录', source: '来源文件', original: 'GitHub 原文', theme: '切换主题', skip: '跳转到正文', language: '文档语言', nav: '文档导航', foot: 'Strata 运行环境与本地模型服务，一站管理。',
  };
  const content = entry.plain
    ? { html: `<h1 id="${escape(entry.key)}">${escape(entry.label)}</h1><pre class="license-text">${escape(markdown)}</pre>`, headings: [] }
    : renderMarkdownContent(entry.changelog ? renderChangelog(markdown, entry.lang) : markdown, entry.source, entry.page);
  const title = content.headings.find((heading) => heading.depth === 1)?.text || entry.label;
  const description = en
    ? `${title}: Strata Manager guides for Niko1221/Strata local LLM inference, model management, services and monitoring.`
    : `${title}：Strata Manager 文档，帮助安装使用 Niko1221/Strata 本地大模型推理引擎，管理模型、服务与监控。`;
  const home = `../${homePage(entry.lang)}`;
  const navItems = [
    ['index', '文档中心', 'Documentation'],
    ['guide', '使用指南', 'User guide'],
    ['download', '下载与体验', 'Download and try'],
    ['changelog', '更新日志', 'Changelog'],
    ['troubleshooting', '故障排查', 'Troubleshooting'],
    ['notices', '第三方声明（中文及许可原文）', 'Third-party notices (Chinese / license originals)'],
    ['license', 'MIT 许可（英文原文）', 'MIT license (English original)'],
    ['outfit', 'Outfit 字体许可（英文原文）', 'Outfit font license (English original)'],
  ].map(([key, zh, english]) => {
    const target = documents.find((item) => item.key === key && item.lang === entry.lang) || documents.find((item) => item.key === key);
    return `<a href="${relativePage(entry.page, target.page)}"${target.page === entry.page ? ' aria-current="page"' : ''}>${escape(en ? english : zh)}</a>`;
  }).join('\n');
  const toc = content.headings.filter((heading) => heading.depth > 1 && heading.depth < 4).map((heading) => `<a class="toc-depth-${heading.depth}" href="#${escape(heading.id)}">${escape(heading.text)}</a>`).join('\n');
  const langLink = alternate
    ? `<a class="header-action" href="${relativePage(entry.page, alternate.page)}" hreflang="${alternate.lang === 'zh' ? 'zh-CN' : 'en'}" lang="${alternate.lang === 'zh' ? 'zh-CN' : 'en'}">${en ? '简体中文' : 'English'}</a>`
    : `<a class="header-action" href="${en ? 'index.html' : 'index.en.html'}">${en ? '中文文档' : 'English docs'}</a>`;
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#f5f4ef" id="theme-color">
  <title>${escape(title)} · Strata Manager</title>
  <meta name="description" content="${escape(description)}">
  ${documentSeo({ title: `${title} · Strata Manager`, description, page: entry.page, lang: entry.lang, alternates: documents.filter((item) => item.key === entry.key) })}
  <link rel="icon" href="../assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../docs.css">
  <script src="../docs.js"></script>
</head>
<body>
  <a class="skip-link" href="#content">${chrome.skip}</a>
  <header class="doc-header">
    <a class="doc-brand" href="${home}"><img src="../assets/icon.svg" width="32" height="32" alt=""><span>Strata <span class="brand-subtitle">Manager</span></span></a>
    <nav class="header-actions" aria-label="${escape(en ? 'Page controls' : '页面操作')}">
      <a class="header-action" href="${home}">${chrome.home}</a>
      ${langLink}
      <button class="header-action" id="doc-theme" type="button" aria-label="${chrome.theme}">${en ? 'Theme' : '主题'}</button>
    </nav>
  </header>
  <div class="doc-layout">
    <aside class="doc-sidebar">
      <details class="doc-navigation" open><summary>${chrome.index}</summary><nav aria-label="${chrome.nav}">${navItems}</nav></details>
    </aside>
    <main id="content" class="doc-main">
      <div class="doc-meta"><span>${chrome.source}：<code>${escape(entry.source)}</code></span><a href="${repository + encodePath(entry.source)}">${chrome.original}</a></div>
      ${entry.languageLabel ? `<p class="language-note">${chrome.language}：${escape(entry.languageLabel)}${alternate ? '' : (en ? ' · This page preserves the available source language.' : ' · 本页保留现有文档语言。')}</p>` : ''}
      ${toc ? `<details class="doc-toc"><summary>${chrome.contents}</summary><nav aria-label="${chrome.contents}">${toc}</nav></details>` : ''}
      <article class="markdown-body">${content.html}</article>
      <footer class="doc-footer"><a href="${en ? 'index.en.html' : 'index.html'}">${chrome.index}</a><span>${chrome.foot}</span><a href="https://github.com/hongfaqiu/strata-manager">GitHub</a></footer>
    </main>
  </div>
</body>
</html>
`;
}

export async function renderWebsiteDocs(output) {
  // Read all sources before publishing, so missing guides fail the build clearly.
  const sources = await Promise.all(documents.map(async (entry) => ({ entry, text: await readFile(join(root, entry.source), 'utf8') })));
  await mkdir(join(output, 'docs'), { recursive: true });
  for (const { entry, text } of sources) await writeFile(join(output, entry.page), renderDocument(entry, text));
  return sources.length;
}

// Fail publication on missing assets/pages or stale in-page links.
export async function verifyStaticWebsite(output) {
  const htmlFiles = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name));
      else if (entry.name.endsWith('.html')) htmlFiles.push(join(directory, entry.name));
    }
  }
  await visit(output);
  const pages = new Map(await Promise.all(htmlFiles.map(async (file) => [file, await readFile(file, 'utf8')])));
  let count = 0;
  for (const [file, html] of pages) {
    for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const url = match[1].replaceAll('&amp;', '&');
      if (!url || /^(?:mailto|tel|data|javascript):/i.test(url)) continue;
      const currentPage = posix.relative(output.replaceAll('\\', '/'), file.replaceAll('\\', '/'));
      const resolvedUrl = new URL(url, new URL(currentPage, site));
      const siteUrl = new URL(site);
      if (resolvedUrl.origin !== siteUrl.origin || !resolvedUrl.pathname.startsWith(siteUrl.pathname)) continue;
      const pathname = decodeURIComponent(resolvedUrl.pathname.slice(siteUrl.pathname.length));
      const hash = resolvedUrl.hash.slice(1);
      let target = resolve(output, pathname || 'index.html');
      if (pathname.endsWith('/')) target = join(target, 'index.html');
      if (target !== output && !target.startsWith(output + sep)) throw new Error(`Website link escapes output: ${url} in ${file}`);
      await access(target).catch(() => { throw new Error(`Missing website target: ${url} in ${file}`); });
      if (hash && pages.has(target)) {
        const id = escape(decodeURIComponent(hash));
        if (!pages.get(target).includes(`id="${id}"`)) throw new Error(`Missing website anchor: ${url} in ${file}`);
      }
      count++;
    }
  }
  return { pages: pages.size, localTargets: count };
}
