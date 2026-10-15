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

  // 网页多语言标题与多屏数据结构
  const pageTitles = {
    zh: 'Strata Manager · Strata 大模型管理与监控',
    en: 'Strata Manager · Local LLM Management & Monitoring for Strata',
  };
  const siteRoot = new URL('.', document.currentScript.src);
  const pageLanguage = document.documentElement.lang === 'en' ? 'en' : 'zh';
  const requestedLanguage = new URLSearchParams(window.location.search).get('lang');
  // Keep old shared language URLs working while each language has crawlable HTML.
  if ((requestedLanguage === 'en' || requestedLanguage === 'zh') && requestedLanguage !== pageLanguage) {
    const destination = new URL(requestedLanguage === 'en' ? 'en/' : './', siteRoot);
    destination.search = window.location.search;
    destination.searchParams.delete('lang');
    destination.hash = window.location.hash;
    window.location.replace(destination.href);
    return;
  }

  const screenshotVersion = '20261014';
  const screenshotUrl = (name) => new URL(`assets/screenshots/${name}.${currentLang}.webp?v=${screenshotVersion}`, siteRoot).href;
  const screens = {
    "overview": {
      "index": "00",
      "image": "overview",
      "zh": {
        "title": "完整总览。",
        "description": "查看模型、API 用量与资源状态。",
        "alt": "Strata Manager 完整总览，包含模型、API 用量与资源状态",
        "badge": "总览"
      },
      "en": {
        "title": "Complete Overview.",
        "description": "View models, API usage and resource status.",
        "alt": "Strata Manager complete Overview with models, API usage and resource status",
        "badge": "OVERVIEW"
      }
    },
    "runtime": {
      "index": "01",
      "image": "runtime",
      "zh": { "title": "环境与模型", "description": "安装并校验 Strata，发现本机权重，维护可用的运行配置。", "alt": "运行环境与模型管理", "badge": "环境与模型" },
      "en": { "title": "Environment & models", "description": "Install and verify Strata, discover local weights, and keep run configurations ready.", "alt": "Runtime and model management", "badge": "ENVIRONMENT" }
    },
    "connections": {
      "index": "02",
      "image": "connections",
      "zh": { "title": "服务与连接", "description": "启停服务，并在同一处配置聊天客户端、API 访问与 MCP。", "alt": "服务与 API / MCP 连接", "badge": "服务与连接" },
      "en": { "title": "Services & connections", "description": "Start and stop services, then wire chat clients, API access and MCP in one place.", "alt": "Services and API / MCP connections", "badge": "CONNECTIONS" }
    },
    "monitor": {
      "index": "03",
      "zh": {
        "title": "监控与评估",
        "description": "查看 GPU、内存与服务活动，并在需要时对照性能表现。",
        "alt": "资源监控与性能评估",
        "badge": "监控与评估"
      },
      "en": {
        "title": "Monitoring & evaluation",
        "description": "Watch GPU, memory and service activity, then compare performance when you need evidence.",
        "alt": "Resource monitoring and performance evaluation",
        "badge": "MONITORING"
      }
    }
  };

  // 提取需要国际化翻译的 DOM 元素
  const translatable = Array.from(document.querySelectorAll('[data-en]')).map(element => ({
    element,
    zh: element.getAttribute('data-zh') ?? element.textContent,
    en: element.dataset.en,
  }));

  const attributeTranslations = [
    ['data-alt-en', 'alt'],
    ['data-title-en', 'title'],
    ['data-label-en', 'aria-label'],
    ['data-content-en', 'content'],
    ['data-href-en', 'href'],
    ['data-src-en', 'src'],
  ].flatMap(([dataAttribute, attribute]) =>
    Array.from(document.querySelectorAll(`[${dataAttribute}]`)).map(element => ({
      element,
      attribute,
      zh: element.getAttribute(dataAttribute.replace(/-en$/, '-zh')) ?? element.getAttribute(attribute),
      en: element.getAttribute(dataAttribute),
    }))
  );

  // DOM 节点引用
  const languageButton = document.getElementById('language-switch');
  const languageLabel = document.getElementById('language-label');
  const heroImage = document.getElementById('hero-preview-img');

  // 灯箱引用
  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxBadge = document.getElementById('lightbox-badge');
  const lightboxTitle = document.getElementById('lightbox-title');
  const lightboxCloseBtn = document.getElementById('lightbox-close-btn');
  const lightboxBackdrop = document.getElementById('lightbox-backdrop');
  const lightboxDialog = lightboxModal?.querySelector('.lightbox-dialog');
  const lightboxBar = lightboxModal?.querySelector('.lightbox-bar');

  // 移动端菜单
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const primaryNav = document.getElementById('primary-nav');

  const themeButton = document.getElementById('theme-switch');
  const themeColorMeta = document.getElementById('theme-color');
  const THEME_KEY = 'strata-manager-site-theme';

  let activeScreenKey = 'overview';
  let currentLang = 'zh';

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function updateThemeButton() {
    if (!themeButton) return;
    const toLight = currentTheme() === 'dark';
    const label = currentLang === 'en'
      ? (toLight ? 'Switch to light mode' : 'Switch to dark mode')
      : (toLight ? '切换到亮色模式' : '切换到黑夜模式');
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
  }

  function applyTheme(theme, persist = false) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    if (themeColorMeta) themeColorMeta.content = next === 'light' ? '#f5f4ef' : '#101c18';
    if (persist) {
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    }
    updateThemeButton();
  }


  // 设置语言环境
  function setLanguage(nextLang) {
    currentLang = nextLang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
    document.title = pageTitles[currentLang];

    translatable.forEach(item => {
      item.element.textContent = item[currentLang];
    });

    if (activeReleaseTag) {
      document.querySelectorAll('.release-version').forEach(el => {
        el.textContent = activeReleaseTag;
      });
    }
    renderReleaseStatus();

    attributeTranslations.forEach(item => {
      const val = item[currentLang];
      if (val !== null && val !== undefined) {
        item.element.setAttribute(item.attribute, val);
      }
    });

    const ogLocale = document.getElementById('og-locale');
    const ogLocaleAlt = document.getElementById('og-locale-alternate');
    if (ogLocale) ogLocale.content = currentLang === 'en' ? 'en_US' : 'zh_CN';
    if (ogLocaleAlt) ogLocaleAlt.content = currentLang === 'en' ? 'zh_CN' : 'en_US';

    if (languageLabel) languageLabel.textContent = currentLang === 'en' ? '中文' : 'EN';
    const switchAction = currentLang === 'en' ? 'Switch to 简体中文' : 'Switch to English';
    if (languageButton) {
      languageButton.setAttribute('aria-label', switchAction);
      languageButton.title = switchAction;
    }

    if (heroImage) heroImage.src = screenshotUrl('product-cover');
    if (lightboxModal.classList.contains('active')) openLightbox(lightboxModal.dataset.screen);
    updateThemeButton();

  }


  // 语言切换按钮
  if (languageButton) {
    languageButton.addEventListener('click', () => {
      const destination = new URL(currentLang === 'zh' ? 'en/' : './', siteRoot);
      destination.search = window.location.search;
      destination.searchParams.delete('lang');
      destination.hash = window.location.hash;
      languageButton.href = destination.href;
    });
  }

  // 全屏灯箱 (Lightbox) 交互控制
  let lightboxOpener = null;
  const backgroundSections = [document.querySelector('.site-header'), document.querySelector('main'), document.querySelector('.site-footer')];
  function fitLightboxImage() {
    if (!lightboxModal?.classList.contains('active') || !lightboxDialog || !lightboxBar) return;
    const modalStyle = getComputedStyle(lightboxModal);
    const dialogStyle = getComputedStyle(lightboxDialog);
    const availableHeight = lightboxModal.clientHeight
      - parseFloat(modalStyle.paddingTop) - parseFloat(modalStyle.paddingBottom)
      - parseFloat(dialogStyle.borderTopWidth) - parseFloat(dialogStyle.borderBottomWidth)
      - lightboxBar.getBoundingClientRect().height;
    lightboxDialog.style.setProperty('--lightbox-image-height', `${Math.max(1, availableHeight)}px`);
  }
  if (lightboxModal && lightboxBar && typeof ResizeObserver !== 'undefined') {
    const lightboxResizeObserver = new ResizeObserver(fitLightboxImage);
    lightboxResizeObserver.observe(lightboxModal);
    lightboxResizeObserver.observe(lightboxBar);
  }
  window.addEventListener('resize', fitLightboxImage);

  function openLightbox(screenKey) {
    const requestedKey = screenKey || activeScreenKey;
    const key = screens[requestedKey] ? requestedKey : 'overview';
    const item = screens[key];
    const copy = item[currentLang];

    lightboxImg.src = screenshotUrl(item.image || key);
    lightboxImg.alt = copy.alt;
    lightboxImg.width = item.width || 2880;
    lightboxImg.height = copy.height || item.height || 1920;
    lightboxBadge.textContent = item.index + ' / ' + key.toUpperCase();
    lightboxTitle.textContent = copy.title;

    if (!lightboxModal.classList.contains('active')) lightboxOpener = document.activeElement;
    lightboxModal.classList.add('active');
    lightboxModal.dataset.screen = key;
    lightboxModal.setAttribute('aria-hidden', 'false');
    fitLightboxImage();
    document.body.style.overflow = 'hidden';
    backgroundSections.forEach(section => { if (section) section.inert = true; });
    lightboxCloseBtn?.focus();
  }

  function closeLightbox() {
    lightboxModal.classList.remove('active');
    lightboxModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    backgroundSections.forEach(section => { if (section) section.inert = false; });
    lightboxOpener?.focus({ preventScroll: true });
  }

  document.querySelectorAll('.open-lightbox-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openLightbox(btn.dataset.target || activeScreenKey);
    });
  });

  if (lightboxCloseBtn) lightboxCloseBtn.addEventListener('click', closeLightbox);
  if (lightboxBackdrop) lightboxBackdrop.addEventListener('click', closeLightbox);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightboxModal.classList.contains('active')) {
      closeLightbox();
    }
    if (e.key === 'Tab' && lightboxModal.classList.contains('active')) {
      e.preventDefault();
      lightboxCloseBtn?.focus();
    }
  });

  // 移动端汉堡菜单控制
  if (mobileMenuBtn && primaryNav) {
    mobileMenuBtn.addEventListener('click', () => {
      const isOpen = primaryNav.classList.toggle('open');
      mobileMenuBtn.setAttribute('aria-expanded', String(isOpen));
    });

    primaryNav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        primaryNav.classList.remove('open');
        mobileMenuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
    });
  }

  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', event => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
      if (saved !== 'light' && saved !== 'dark') applyTheme(event.matches ? 'light' : 'dark');
    });
  } catch (_) {}

  // 初始化语言
  const initialLanguage = pageLanguage;

  // Enable downloads only after validating published assets from this repository.
  let activeReleaseTag = null;
  let releaseState = { kind: 'loading' };

  function renderReleaseStatus() {
    const status = document.getElementById('download-status');
    if (!status) return;
    const english = currentLang === 'en';
    if (releaseState.kind === 'loading') {
      status.textContent = english ? 'Checking published packages…' : '正在检查已发布安装包…';
    } else if (releaseState.kind === 'unavailable') {
      activeReleaseTag = english ? 'Unavailable' : '暂无可用发布';
      document.querySelectorAll('.release-version').forEach(el => { el.textContent = activeReleaseTag; });
      status.textContent = english ? 'Published packages could not be verified. Open GitHub Releases to check availability, or try again later.' : '暂时无法核验已发布安装包。请打开 GitHub 发布页查看，或稍后重试。';
    } else {
      const channel = releaseState.preview
        ? (english ? 'No published release is available yet; packages below are for manual installation only.' : '暂无已发布安装包；以下仅供手工安装。')
        : releaseState.snapshot
          ? (english ? 'Published release.' : '已发布版本。')
          : (english ? 'Latest release.' : '最新发布版本。');
      const labels = { windows: 'Windows', appimage: 'AppImage', deb: 'DEB', checksums: 'SHA256SUMS' };
      const missing = releaseState.missing.map(key => labels[key]).join(' / ');
      status.textContent = `${channel}${missing ? (english ? ` Unavailable assets: ${missing}. Those downloads are disabled.` : ` 缺少 ${missing} 资产，对应下载已禁用。`) : ''}`;
    }
  }

  function applyRelease(release, source = 'live') {
    const urls = strataReleaseCatalog.assets(release);
    activeReleaseTag = release?.tag_name || (currentLang === 'en' ? 'Unavailable' : '暂无可用发布');
    releaseState = release ? { kind: 'ready', preview: release.prerelease, snapshot: source === 'snapshot', missing: strataReleaseCatalog.keys.filter(key => !urls[key]) } : { kind: 'unavailable' };
    document.querySelectorAll('.release-version').forEach(el => {
      el.textContent = activeReleaseTag;
    });
    const elements = Object.fromEntries(strataReleaseCatalog.keys.map(key => [key, document.querySelector(`[data-download="${key}"]`)]));
    strataReleaseCatalog.applyDownloads(elements, urls);
    const notesBtn = document.getElementById('release-notes-link');
    if (notesBtn) notesBtn.href = urls.notes || `https://github.com/${strataReleaseCatalog.repo}/releases`;
    renderReleaseStatus();
  }

  async function fetchLatestRelease() {
    async function metadata(url, single) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const value = response.ok ? await response.json() : [];
        return { status: response.status, releases: response.ok && single ? [value] : value };
      } finally { clearTimeout(timeout); }
    }
    // A public catalog checked during deployment keeps downloads working when
    // GitHub rate-limits anonymous visitors. Asset URLs still use the same validator.
    const snapshotPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(new URL('release-catalog.json', siteRoot), { signal: controller.signal });
        if (!response.ok) return null;
        const snapshot = await response.json();
        if (snapshot?.schemaVersion !== 1 || !Number.isFinite(Date.parse(snapshot.generatedAt))) return null;
        const release = strataReleaseCatalog.select([snapshot.release]);
        if (release) applyRelease(release, 'snapshot');
        return release;
      } catch (_) { return null; }
      finally { clearTimeout(timeout); }
    })();
    try {
      const prefix = `https://api.github.com/repos/${strataReleaseCatalog.repo}/releases`;
      const results = await Promise.allSettled([
        metadata(`${prefix}/latest`, true),
        metadata(`${prefix}?per_page=100`, false),
      ]);
      const latest = results[0].status === 'fulfilled' ? results[0].value : null;
      const list = results[1].status === 'fulfilled' ? results[1].value : null;
      const snapshot = await snapshotPromise;
      const live = strataReleaseCatalog.selectResponses(latest, list);
      if (live) applyRelease(live);
      else if (!snapshot) applyRelease(null);
    } catch (_) {
      if (!await snapshotPromise) applyRelease(null);
    }
  }

  function animatePage() {
    if (!window.gsap || !window.ScrollTrigger) return;
    const { gsap, ScrollTrigger } = window;
    gsap.registerPlugin(ScrollTrigger);
    // No scroll interception or pinned stages; the page remains a normal document.
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('.hero-title-block, .hero-content', { y: 22, opacity: 0, duration: .7, stagger: .1, ease: 'power3.out' });
      gsap.fromTo('.hero-cover', { scale: .86, y: 36 }, {
        scale: 1, y: 0, ease: 'none',
        scrollTrigger: { trigger: '.hero-cover', start: 'top 92%', end: 'top 100px', scrub: true, invalidateOnRefresh: true },
      });
      gsap.from('.feature-card', { y: 26, opacity: 0, duration: .55, stagger: .08, ease: 'power3.out', scrollTrigger: { trigger: '.feature-grid', start: 'top 90%', once: true } });
      gsap.from('.workspace-display-frame', { y: 18, opacity: 0, duration: .8, ease: 'power3.out', scrollTrigger: { trigger: '.workspace-display-frame', start: 'top 90%', once: true } });
      gsap.utils.toArray('.gallery-item').forEach(item => gsap.from(item, { y: 18, opacity: 0, duration: .5, ease: 'power3.out', scrollTrigger: { trigger: item, start: 'top 92%', once: true } }));
      gsap.from('.download-card', { x: -18, opacity: 0, duration: .5, stagger: .1, ease: 'power3.out', scrollTrigger: { trigger: '.download-cards-grid', start: 'top 90%', once: true } });
    });
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  }

  setLanguage(initialLanguage);
  animatePage();
  fetchLatestRelease();
})();
