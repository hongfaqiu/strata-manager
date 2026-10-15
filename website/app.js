/* Strata Manager · Modern Interactive Application Engine */
// Release catalog contract is independent of DOM and network state.
const strataReleaseCatalog = (() => {
  const repo = 'hongfaqiu/strata-manager';
  const base = `https://github.com/${repo}/releases`;
  const keys = ['windows', 'appimage', 'deb', 'checksums'];

  function version(tag) {
    if (typeof tag !== 'string') return null;
    const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
    if (!match) return null;
    const prerelease = match[4] ? match[4].split('.') : [];
    if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
    return { numbers: match.slice(1, 4).map(BigInt), prerelease };
  }

  function compare(left, right) {
    for (let i = 0; i < 3; i += 1) {
      if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
    }
    if (!left.prerelease.length || !right.prerelease.length) {
      return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
    }
    for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
      const a = left.prerelease[i];
      const b = right.prerelease[i];
      if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
      if (a === b) continue;
      const numericA = /^\d+$/.test(a);
      const numericB = /^\d+$/.test(b);
      if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
      if (numericA !== numericB) return numericA ? -1 : 1;
      return a > b ? 1 : -1;
    }
    return 0;
  }

  function validRelease(release) {
    const parsed = version(release?.tag_name);
    if (!parsed || release.draft !== false || typeof release.prerelease !== 'boolean') return null;
    if (release.prerelease !== Boolean(parsed.prerelease.length)) return null;
    if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) return null;
    if (release.html_url !== `${base}/tag/${release.tag_name}`) return null;
    return parsed;
  }

  function select(releases, allowPreview = true) {
    if (!Array.isArray(releases)) return null;
    const valid = releases.map(release => ({ release, parsed: validRelease(release) })).filter(item => item.parsed);
    const stable = valid.filter(item => !item.release.prerelease);
    const candidates = stable.length ? stable : allowPreview ? valid : [];
    candidates.sort((a, b) => compare(b.parsed, a.parsed) || b.release.published_at.localeCompare(a.release.published_at));
    return candidates[0]?.release || null;
  }

  function assets(release) {
    if (!validRelease(release)) return {};
    const tag = release.tag_name;
    const clean = tag.slice(1);
    const names = {
      windows: `Strata.Manager_${clean}_x64-setup.exe`,
      appimage: `Strata.Manager_${clean}_amd64.AppImage`,
      deb: `Strata.Manager_${clean}_amd64.deb`,
      checksums: 'SHA256SUMS',
    };
    const result = { notes: release.html_url };
    for (const key of keys) {
      const matches = (Array.isArray(release.assets) ? release.assets : []).filter(asset =>
        asset.name === names[key] && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0 &&
        asset.browser_download_url === `${base}/download/${tag}/${names[key]}`);
      if (matches.length === 1) result[key] = matches[0].browser_download_url;
    }
    return result;
  }

  function selectResponses(latest, list) {
    const candidates = [
      ...(latest?.status === 200 && Array.isArray(latest.releases) ? latest.releases : []),
      ...(list?.status === 200 && Array.isArray(list.releases) ? list.releases : []),
    ];
    // An unavailable stable endpoint is not proof that no stable release exists.
    return select(candidates, latest?.status === 404 && list?.status === 200);
  }

  function applyDownloads(elements, urls) {
    for (const key of keys) {
      const element = elements[key];
      if (!element) continue;
      if (urls[key]) {
        element.setAttribute('href', urls[key]);
        element.removeAttribute('aria-disabled');
        element.removeAttribute('tabindex');
      } else {
        element.removeAttribute('href');
        element.setAttribute('aria-disabled', 'true');
        element.setAttribute('tabindex', '-1');
      }
    }
  }

  return Object.freeze({ repo, keys, version, compare, select, selectResponses, assets, applyDownloads });
})();

// Website interactions.
(() => {
  'use strict';

  const siteRoot = new URL('.', document.querySelector('script[src*="app.js"]').src);
  const lang = document.documentElement.lang === 'en' ? 'en' : 'zh';
  const en = lang === 'en';

  // Old ?lang= links still land on the right static page.
  const requested = new URLSearchParams(window.location.search).get('lang');
  if ((requested === 'en' || requested === 'zh') && requested !== lang) {
    const destination = new URL(requested === 'en' ? 'en/' : './', siteRoot);
    destination.search = window.location.search;
    destination.searchParams.delete('lang');
    destination.hash = window.location.hash;
    window.location.replace(destination.href);
    return;
  }

  const languageSwitch = document.getElementById('language-switch');
  if (languageSwitch) {
    languageSwitch.addEventListener('click', () => {
      const destination = new URL(en ? './' : 'en/', siteRoot);
      destination.hash = window.location.hash;
      languageSwitch.href = destination.href;
    });
  }

  // Asset links stay disabled until a published release validates (same rule
  // as the deploy snapshot). The hero buttons scroll to the download table
  // until then, and afterwards point straight at the verified installer.
  const status = document.getElementById('download-status');
  const notes = document.getElementById('release-notes-link');

  function date(value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
  }

  function applyRelease(release) {
    const urls = strataReleaseCatalog.assets(release);
    const elements = Object.fromEntries(strataReleaseCatalog.keys.map((key) => [key, document.querySelector(`[data-download="${key}"]`)]));
    strataReleaseCatalog.applyDownloads(elements, urls);
    document.querySelectorAll('[data-download-mirror]').forEach((link) => {
      link.href = urls[link.dataset.downloadMirror] || '#get-started';
    });
    if (notes) notes.href = urls.notes || `https://github.com/${strataReleaseCatalog.repo}/releases`;
    if (!status) return;
    if (!release) {
      status.textContent = en
        ? 'Couldn’t read release info just now. Grab the installer from GitHub Releases instead.'
        : '暂时没读到发布信息，直接去 GitHub 发布页下载吧。';
      return;
    }
    const labels = { windows: '.exe', appimage: 'AppImage', deb: '.deb', checksums: 'SHA256SUMS' };
    const missing = strataReleaseCatalog.keys.filter((key) => !urls[key]).map((key) => labels[key]).join(' / ');
    const when = date(release.published_at);
    let line = en
      ? `Latest release: ${release.tag_name}${when ? `, published ${when}` : ''}.`
      : `最新发布版本：${release.tag_name}${when ? `，${when} 发布` : ''}。`;
    if (release.prerelease) line += en ? ' This is a preview build.' : ' 这是预览构建。';
    if (missing) line += en ? ` ${missing} isn’t attached to this one, so that link is off.` : ` 这一版没有 ${missing}，对应链接先关掉了。`;
    status.textContent = line;
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return { status: response.status, value: response.ok ? await response.json() : null };
    } finally { window.clearTimeout(timeout); }
  }

  async function loadRelease() {
    // The deploy-time snapshot keeps links exact when GitHub rate-limits visitors.
    let snapshot = null;
    try {
      const { value } = await fetchJson(new URL('release-catalog.json', siteRoot));
      if (value?.schemaVersion === 1 && Number.isFinite(Date.parse(value.generatedAt))) {
        snapshot = strataReleaseCatalog.select([value.release]);
        if (snapshot) applyRelease(snapshot);
      }
    } catch (_) { /* fall through to the live API */ }
    try {
      const prefix = `https://api.github.com/repos/${strataReleaseCatalog.repo}/releases`;
      const [latest, list] = await Promise.allSettled([fetchJson(`${prefix}/latest`), fetchJson(`${prefix}?per_page=100`)]);
      const pack = (result, single) => result.status === 'fulfilled'
        ? { status: result.value.status, releases: single ? [result.value.value] : result.value.value }
        : null;
      const live = strataReleaseCatalog.selectResponses(pack(latest, true), pack(list, false));
      if (live) applyRelease(live);
      else if (!snapshot) applyRelease(null);
    } catch (_) {
      if (!snapshot) applyRelease(null);
    }
  }

  loadRelease();
})();
