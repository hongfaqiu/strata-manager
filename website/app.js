/* Strata Manager marketing site */
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

  const pageTitles = {
    zh: 'Strata Manager · 本地大模型桌面管理',
    en: 'Strata Manager · Local LLM desktop manager',
  };
  const siteRoot = new URL('.', document.currentScript.src);
  const pageLanguage = document.documentElement.lang === 'en' ? 'en' : 'zh';
  const requestedLanguage = new URLSearchParams(window.location.search).get('lang');
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
    overview: {
      index: '00', image: 'overview',
      zh: { title: '总览', description: '模型、API 用量与资源状态。', alt: 'Strata Manager 总览界面', badge: '总览' },
      en: { title: 'Overview', description: 'Models, API usage and resources.', alt: 'Strata Manager overview', badge: 'OVERVIEW' },
    },
    models: {
      index: '01',
      zh: { title: '模型与服务', description: '发现权重、切换配置、控制服务。', alt: '模型与服务管理', badge: '模型' },
      en: { title: 'Models & services', description: 'Discover weights, switch configs, control services.', alt: 'Models and services', badge: 'MODELS' },
    },
    chat: {
      index: '02',
      zh: { title: '聊天', description: '多会话、流式回复与附件。', alt: '聊天工作区', badge: '聊天' },
      en: { title: 'Chat', description: 'Conversations, streaming replies and attachments.', alt: 'Chat workspace', badge: 'CHAT' },
    },
    monitor: {
      index: '03',
      zh: { title: '监控', description: 'GPU、显存、CPU 与服务状态。', alt: '硬件与资源监控', badge: '监控' },
      en: { title: 'Monitor', description: 'GPU, memory, CPU and service activity.', alt: 'Hardware monitoring', badge: 'MONITOR' },
    },
  };

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

  const languageButton = document.getElementById('language-switch');
  const languageLabel = document.getElementById('language-label');
  const heroImage = document.getElementById('hero-preview-img');
  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxBadge = document.getElementById('lightbox-badge');
  const lightboxTitle = document.getElementById('lightbox-title');
  const lightboxCloseBtn = document.getElementById('lightbox-close-btn');
  const lightboxBackdrop = document.getElementById('lightbox-backdrop');
  const lightboxDialog = lightboxModal?.querySelector('.lightbox-dialog');
  const lightboxBar = lightboxModal?.querySelector('.lightbox-bar');
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const primaryNav = document.getElementById('primary-nav');
  const themeButton = document.getElementById('theme-switch');
  const themeColorMeta = document.getElementById('theme-color');
  const THEME_KEY = 'strata-manager-site-theme';

  let currentLang = 'zh';
  let activeScreenKey = 'overview';

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
    if (themeColorMeta) themeColorMeta.content = next === 'light' ? '#f7f8fa' : '#050508';
    if (persist) {
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    }
    updateThemeButton();
  }

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
    if (lightboxModal?.classList.contains('active')) openLightbox(lightboxModal.dataset.screen);
    updateThemeButton();
  }

  if (languageButton) {
    languageButton.addEventListener('click', () => {
      const destination = new URL(currentLang === 'zh' ? 'en/' : './', siteRoot);
      destination.search = window.location.search;
      destination.searchParams.delete('lang');
      destination.hash = window.location.hash;
      languageButton.href = destination.href;
    });
  }

  let lightboxOpener = null;
  const backgroundSections = [
    document.querySelector('.site-header'),
    document.querySelector('main'),
    document.querySelector('.site-footer'),
  ];

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
    activeScreenKey = key;

    lightboxImg.src = screenshotUrl(item.image || key);
    lightboxImg.alt = copy.alt;
    lightboxImg.width = item.width || 2880;
    lightboxImg.height = copy.height || item.height || 1920;
    lightboxBadge.textContent = `${item.index} / ${key.toUpperCase()}`;
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
    if (e.key === 'Escape' && lightboxModal?.classList.contains('active')) closeLightbox();
    if (e.key === 'Tab' && lightboxModal?.classList.contains('active')) {
      e.preventDefault();
      lightboxCloseBtn?.focus();
    }
  });

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
      status.textContent = english
        ? 'Published packages could not be verified. Open GitHub Releases to check availability, or try again later.'
        : '暂时无法核验已发布安装包。请打开 GitHub 发布页查看，或稍后重试。';
    } else {
      const channel = releaseState.preview
        ? (english ? 'No stable release is published; showing a preview for manual installation.' : '暂无稳定版发布，以下为手工安装的预览版。')
        : releaseState.snapshot
          ? (english ? 'Published stable release.' : '已发布稳定版。')
          : (english ? 'Latest published stable release.' : '最新已发布稳定版。');
      const labels = { windows: 'Windows', appimage: 'AppImage', deb: 'DEB', checksums: 'SHA256SUMS' };
      const missing = releaseState.missing.map(key => labels[key]).join(' / ');
      status.textContent = `${channel}${missing ? (english ? ` Unavailable assets: ${missing}. Those downloads are disabled.` : ` 缺少 ${missing} 资产，对应下载已禁用。`) : ''}`;
    }
  }

  function applyRelease(release, source = 'live') {
    const urls = strataReleaseCatalog.assets(release);
    activeReleaseTag = release?.tag_name || (currentLang === 'en' ? 'Unavailable' : '暂无可用发布');
    releaseState = release
      ? { kind: 'ready', preview: release.prerelease, snapshot: source === 'snapshot', missing: strataReleaseCatalog.keys.filter(key => !urls[key]) }
      : { kind: 'unavailable' };
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
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const { gsap, ScrollTrigger } = window;
    gsap.registerPlugin(ScrollTrigger);
    gsap.from('.hero-eyebrow, .hero-title, .hero-lead, .hero-cta', {
      y: 28, opacity: 0, duration: 0.75, stagger: 0.1, ease: 'power3.out',
    });
    gsap.from('.hero-frame', {
      y: 48, opacity: 0, scale: 0.94, duration: 1, delay: 0.2, ease: 'power3.out',
    });
    gsap.from('.reveal-proof', {
      y: 16, opacity: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out',
      scrollTrigger: { trigger: '.proof', start: 'top 88%', once: true },
    });
    document.querySelectorAll('.feature-grid, .arch-grid, .download-grid').forEach((grid) => {
      gsap.from(grid.querySelectorAll('.reveal-card'), {
        y: 28, opacity: 0, duration: 0.55, stagger: 0.07, ease: 'power3.out',
        scrollTrigger: { trigger: grid, start: 'top 90%', once: true },
      });
    });
    gsap.utils.toArray('.reveal-shot').forEach((item) => {
      gsap.from(item, {
        y: 32, opacity: 0, duration: 0.65, ease: 'power3.out',
        scrollTrigger: { trigger: item, start: 'top 90%', once: true },
      });
    });
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  }

  setLanguage(pageLanguage);
  animatePage();
  fetchLatestRelease();
})();
