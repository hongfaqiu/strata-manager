import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const site = 'https://hongfaqiu.github.io/strata-manager/';
export const languageCode = (language) => language === 'en' ? 'en' : 'zh-CN';
export const homePage = (language) => language === 'en' ? 'en/' : '';
export const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function decodeHtml(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]*);/gi, (entity, name) => {
    if (name.startsWith('#')) {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    }
    if (!(name in named)) throw new Error(`Unsupported HTML entity in website translation: ${entity}`);
    return named[name];
  });
}

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// The landing page uses explicit closing tags. This source-preserving parser
// handles quoted/multiline attributes, SVG, comments and raw scripts/styles;
// it rejects malformed source instead of silently producing incomplete pages.
// A DOM dependency is deliberately unnecessary for this static build.
export function parseWebsiteHtml(source) {
  const root = { children: [] };
  const stack = [root];
  let offset = 0;
  while (offset < source.length) {
    const parent = stack.at(-1);
    if (parent.tag === 'script' || parent.tag === 'style') {
      const end = source.toLowerCase().indexOf(`</${parent.tag}`, offset);
      if (end < 0) throw new Error(`Unclosed ${parent.tag} in website source`);
      if (end > offset) parent.children.push({ raw: source.slice(offset, end) });
      offset = end;
    }
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0) throw new Error('Unclosed website comment');
      parent.children.push({ raw: source.slice(offset, end + 3) });
      offset = end + 3;
      continue;
    }
    if (source[offset] !== '<') {
      let end = source.indexOf('<', offset);
      if (end < 0) end = source.length;
      parent.children.push({ text: source.slice(offset, end) });
      offset = end;
      continue;
    }
    let end = offset + 1;
    let quote;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = undefined; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === source.length) throw new Error('Unclosed website tag');
    const token = source.slice(offset, end + 1);
    offset = end + 1;
    if (/^<!doctype\s/i.test(token)) { parent.children.push({ raw: token }); continue; }
    const closing = /^<\/\s*([\w:-]+)\s*>$/.exec(token);
    if (closing) {
      if (stack.at(-1).tag !== closing[1].toLowerCase()) throw new Error(`Mismatched website closing tag: ${token}`);
      stack.pop();
      continue;
    }
    const opening = /^<([\w:-]+)([\s\S]*?)(\/?)>$/.exec(token);
    if (!opening) throw new Error(`Unsupported website tag: ${token}`);
    const attributes = new Map();
    let remainder = opening[2];
    while (remainder.trim()) {
      const attribute = /^\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(remainder);
      if (!attribute) throw new Error(`Invalid website attributes: ${token}`);
      const name = attribute[1].toLowerCase();
      if (attributes.has(name)) throw new Error(`Duplicate website attribute: ${name}`);
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      attributes.set(name, value === undefined ? null : decodeHtml(value));
      remainder = remainder.slice(attribute[0].length);
    }
    const node = { tag: opening[1].toLowerCase(), attributes, children: [], selfClosing: Boolean(opening[3]) };
    parent.children.push(node);
    if (!node.selfClosing && !voidElements.has(node.tag)) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`Unclosed website element: ${stack.at(-1).tag}`);
  return root;
}

function serialize(node) {
  if (node.raw !== undefined) return node.raw;
  if (node.text !== undefined) return node.text;
  if (!node.tag) return node.children.map(serialize).join('');
  const attributes = [...node.attributes].map(([name, value]) => value === null ? name : `${name}="${escapeHtml(value)}"`).join(' ');
  const start = `<${node.tag}${attributes ? ` ${attributes}` : ''}${node.selfClosing ? '/' : ''}>`;
  if (node.selfClosing || voidElements.has(node.tag)) return start;
  return `${start}${node.children.map(serialize).join('')}</${node.tag}>`;
}

function elements(root) {
  const result = [];
  function visit(node) {
    if (node.tag) result.push(node);
    for (const child of node.children || []) visit(child);
  }
  visit(root);
  return result;
}

function textOf(node) {
  return (node.children || []).map((child) => child.text !== undefined ? decodeHtml(child.text) : child.raw !== undefined ? '' : textOf(child)).join('');
}

function text(node, value) { node.children = [{ text: escapeHtml(value) }]; }

function element(tag, attributes, children = []) {
  return { tag, attributes: new Map(Object.entries(attributes)), children };
}

function pageUrl(page) { return new URL(page, site).href; }

export function languageLinks(entries, defaultPage) {
  return entries.map(({ page, lang }) => `<link rel="alternate" hreflang="${languageCode(lang)}" href="${escapeHtml(pageUrl(page))}">`).join('\n  ')
    + (defaultPage === undefined ? '' : `\n  <link rel="alternate" hreflang="x-default" href="${escapeHtml(pageUrl(defaultPage))}">`);
}

export function documentSeo({ title, description, page, lang, alternates }) {
  const url = pageUrl(page);
  const alternate = alternates.find((entry) => entry.lang !== lang);
  const structured = { '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${url}#webpage`, name: title, description, url, inLanguage: languageCode(lang), isPartOf: { '@type': 'WebSite', name: 'Strata Manager', url: site } };
  return `<link rel="canonical" href="${escapeHtml(url)}">
  ${languageLinks(alternates, alternates.find((entry) => entry.lang === 'zh')?.page)}
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Strata Manager">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'zh_CN'}">
  ${alternate ? `<meta property="og:locale:alternate" content="${alternate.lang === 'en' ? 'en_US' : 'zh_CN'}">` : ''}
  <meta property="og:image" content="${site}assets/screenshots/product-cover.${lang}.webp">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${site}assets/screenshots/product-cover.${lang}.webp">
  <script type="application/ld+json">${JSON.stringify(structured).replaceAll('<', '\\u003c')}</script>`;
}

export function renderHomepage(source, language) {
  if (language !== 'zh' && language !== 'en') throw new Error(`Unknown website language: ${language}`);
  const root = parseWebsiteHtml(source);
  const nodes = elements(root);
  const html = nodes.find((node) => node.tag === 'html');
  const head = nodes.find((node) => node.tag === 'head');
  const title = nodes.find((node) => node.tag === 'title');
  if (!html || !head || !title) throw new Error('Website requires html, head and title');
  html.attributes.set('lang', languageCode(language));
  for (const node of nodes) {
    if (node.attributes.has('data-en')) {
      if (!node.attributes.has('data-zh')) node.attributes.set('data-zh', textOf(node));
      if (language === 'en') text(node, node.attributes.get('data-en'));
    }
    for (const [name, english] of [...node.attributes]) {
      const match = /^data-(.+)-en$/.exec(name);
      if (!match) continue;
      const suffix = match[1];
      const target = suffix === 'label' ? 'aria-label' : suffix;
      if (!node.attributes.has(target)) continue;
      if (!node.attributes.has(`data-${suffix}-zh`)) node.attributes.set(`data-${suffix}-zh`, node.attributes.get(target));
      if (language === 'en') node.attributes.set(target, english);
    }
  }
  const meta = (property) => nodes.find((node) => node.tag === 'meta' && (node.attributes.get('property') === property || node.attributes.get('name') === property));
  const description = meta('description')?.attributes.get('content');
  if (!description) throw new Error('Website requires a translated meta description');
  if (language === 'en' && !title.attributes.has('data-en')) {
    const englishTitle = meta('og:title')?.attributes.get('content');
    if (!englishTitle) throw new Error('Website requires an English title');
    text(title, englishTitle);
  }
  const url = pageUrl(homePage(language));
  for (const property of ['og:url', 'twitter:url']) {
    const node = meta(property);
    if (node) node.attributes.set('content', url);
  }
  const locale = meta('og:locale');
  const alternateLocale = meta('og:locale:alternate');
  if (locale) locale.attributes.set('content', language === 'en' ? 'en_US' : 'zh_CN');
  if (alternateLocale) alternateLocale.attributes.set('content', language === 'en' ? 'zh_CN' : 'en_US');
  head.children = head.children.filter((node) => !(node.tag === 'link' && (node.attributes.get('rel') === 'canonical' || (node.attributes.get('rel') === 'alternate' && node.attributes.has('hreflang')))));
  head.children.push(element('link', { rel: 'canonical', href: url }));
  for (const [lang, page] of [['zh-CN', ''], ['en', 'en/'], ['x-default', '']]) {
    head.children.push({ text: '\n  ' }, element('link', { rel: 'alternate', hreflang: lang, href: pageUrl(page) }));
  }
  for (const node of nodes.filter((item) => item.tag === 'script' && item.attributes.get('type') === 'application/ld+json')) {
    const structured = JSON.parse(node.children.map((child) => child.raw ?? child.text ?? '').join(''));
    function localize(value) {
      if (!value || typeof value !== 'object') return;
      if (['SoftwareApplication', 'WebPage', 'WebSite'].includes(value['@type'])) {
        value.url = url;
        value.inLanguage = languageCode(language);
        value.description = description;
        if (value['@id']) value['@id'] = `${url}#${value['@id'].split('#').at(-1)}`;
        if (typeof value.screenshot === 'string') value.screenshot = value.screenshot.replace(/\.(?:zh|en)\.webp$/, `.${language}.webp`);
      }
      for (const child of Object.values(value)) if (typeof child === 'object') localize(child);
    }
    localize(structured);
    node.children = [{ raw: JSON.stringify(structured, null, 2).replaceAll('<', '\\u003c') }];
  }
  if (language === 'en') {
    // Keep fragment navigation on /en/. Other local destinations resolve at the
    // project root, including source translations retained for the interaction JS.
    for (const node of nodes) {
      for (const [name, value] of [...node.attributes]) {
        if (!/^(?:href|src|data-(?:href|src)-(?:en|zh))$/.test(name) || !value || /^(?:#|\/|[a-z][a-z\d+.-]*:)/i.test(value)) continue;
        node.attributes.set(name, `../${value}`);
      }
    }
  }
  const languageSwitch = nodes.find((node) => node.attributes.get('id') === 'language-switch');
  if (languageSwitch?.tag === 'a') {
    languageSwitch.attributes.set('href', language === 'en' ? '../' : 'en/');
    languageSwitch.attributes.set('hreflang', language === 'en' ? 'zh-CN' : 'en');
    languageSwitch.attributes.set('lang', language === 'en' ? 'zh-CN' : 'en');
    const switchAction = language === 'en' ? 'Switch to 简体中文' : '切换到 English';
    languageSwitch.attributes.set('aria-label', switchAction);
    languageSwitch.attributes.set('title', switchAction);
    const languageLabel = nodes.find((node) => node.attributes.get('id') === 'language-label');
    if (languageLabel) text(languageLabel, language === 'en' ? '中文' : 'EN');
  }
  return serialize(root);
}

export function renderSitemap(documents) {
  const homepages = [{ page: '', lang: 'zh', key: 'home' }, { page: 'en/', lang: 'en', key: 'home' }];
  const pages = [...homepages, ...documents];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages.map((entry) => {
    const pair = pages.filter((other) => other.key === entry.key);
    const alternates = pair.length > 1 ? pair.map((other) => `<xhtml:link rel="alternate" hreflang="${languageCode(other.lang)}" href="${pageUrl(other.page)}"/>`).join('') : '';
    const defaultPage = pair.length > 1 ? pair.find((other) => other.lang === 'zh') : undefined;
    return `  <url><loc>${pageUrl(entry.page)}</loc>${alternates}${defaultPage ? `<xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(defaultPage.page)}"/>` : ''}</url>`;
  }).join('\n')}
</urlset>
`;
}

export async function renderWebsiteSeo(output, documents) {
  const source = await readFile(join(output, 'index.html'), 'utf8');
  await writeFile(join(output, 'index.html'), renderHomepage(source, 'zh'));
  await mkdir(join(output, 'en'), { recursive: true });
  await writeFile(join(output, 'en', 'index.html'), renderHomepage(source, 'en'));
  await writeFile(join(output, 'sitemap.xml'), renderSitemap(documents));
}
