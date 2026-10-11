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
  const siteRoot = new URL('.', document.querySelector('script[src$="app.js"]').src);
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

  const screens = {
    "overview": {
      "index": "00",
      "zh": {
        "title": "查看服务总览。",
        "description": "集中查看模型状态、API 用量与运行指标。",
        "alt": "Strata Manager 总览：模型状态、服务控制、API 用量与运行指标",
        "badge": "总览"
      },
      "en": {
        "title": "View the service overview.",
        "description": "See model status, API usage and runtime metrics in one place.",
        "alt": "Strata Manager overview: model status, service controls, API usage and runtime metrics",
        "badge": "OVERVIEW"
      }
    },
    "models": {
      "index": "01",
      "zh": {
        "title": "管理模型与服务。",
        "description": "发现已有模型、切换配置，统一启停服务。",
        "alt": "Strata 模型管理：本地模型、运行配置与服务控制",
        "badge": "模型管理"
      },
      "en": {
        "title": "Manage models and services.",
        "description": "Discover local models, switch configurations and control services.",
        "alt": "Strata model management: local models, configurations and service controls",
        "badge": "MODELS"
      }
    },
    "monitor": {
      "index": "02",
      "zh": {
        "title": "查看资源占用。",
        "description": "了解 GPU、显存、CPU 和模型的运行状态。",
        "alt": "Strata 硬件监控：GPU、显存、CPU 与服务状态",
        "badge": "硬件监控"
      },
      "en": {
        "title": "Monitor resource usage.",
        "description": "See GPU, memory, CPU and service activity.",
        "alt": "Strata hardware monitoring: GPU, memory, CPU and service activity",
        "badge": "MONITOR"
      }
    },
    "benchmark": {
      "index": "04",
      "zh": { "title": "Benchmark · 基准测试", "description": "场景套件、并发压力与性能报告。", "alt": "Benchmark 工作区：测试计划、场景选择与并发压力参数", "badge": "基准测试" },
      "en": { "title": "Benchmark · Measure and compare", "description": "Scenario suites, concurrent stress tests and performance reports.", "alt": "Benchmark workspace: test plans, scenario selection and concurrent stress settings", "badge": "BENCHMARK" }
    },
    "runtime": {
      "index": "05",
      "zh": { "title": "Strata · 环境管理", "description": "安装检测、版本与运行时更新。", "alt": "Strata 运行环境：安装检测、版本与更新管理", "badge": "运行环境" },
      "en": { "title": "Strata · Prepare the runtime", "description": "Installation detection, versions and runtime updates.", "alt": "Strata runtime: installation detection, versions and updates", "badge": "RUNTIME" }
    },
    "config": {
      "index": "06",
      "zh": { "title": "运行配置 · 编辑与校验", "description": "图形控件、JSON 与配置备份。", "alt": "运行配置：图形化参数、JSON 编辑与配置校验", "badge": "模型配置" },
      "en": { "title": "Configuration · Edit and validate", "description": "Graphical controls, JSON and configuration backups.", "alt": "Runtime configuration: graphical settings, JSON editing and validation", "badge": "CONFIGURATION" }
    },
    "chat": {
      "index": "07",
      "zh": { "title": "聊天 · 与本机模型协作", "description": "会话、流式回复、附件与工具。", "alt": "聊天工作区：多会话、流式回复与附件", "badge": "聊天" },
      "en": { "title": "Chat · Work with your model", "description": "Conversations, streaming, attachments and tools.", "alt": "Chat workspace: conversations, streaming replies and attachments", "badge": "CHAT" }
    },
    "tuning": {
      "index": "08",
      "zh": { "title": "调优 · 比较参数配置", "description": "按任务比较质量、速度与资源占用。", "alt": "参数调优：用途场景、参数候选与对比结果", "badge": "参数调优" },
      "en": { "title": "Tuning · Compare configurations", "description": "Compare quality, speed and resource use for a workload.", "alt": "Parameter tuning: workload scenarios, candidates and comparison results", "badge": "TUNING" }
    },
    "settings": {
      "index": "09",
      "zh": { "title": "设置 · 调整工作台偏好", "description": "语言、外观、托盘与更新偏好。", "alt": "应用设置：语言、外观、后台与更新选项", "badge": "应用偏好" },
      "en": { "title": "Settings · Make it your workspace", "description": "Language, appearance, tray and update preferences.", "alt": "Application settings: language, appearance, background and update options", "badge": "SETTINGS" }
    },
    "usage": {
      "index": "03",
      "zh": {
        "title": "了解 API 用量。",
        "description": "查看请求、tokens、延迟与生成速度趋势。",
        "alt": "Strata API 用量统计：请求、tokens、延迟与生成速度",
        "badge": "API 用量"
      },
      "en": {
        "title": "Understand API usage.",
        "description": "Track requests, tokens, latency and generation speed.",
        "alt": "Strata API usage: requests, tokens, latency and generation speed",
        "badge": "API USAGE"
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
  const wsTabs = Array.from(document.querySelectorAll('.ws-tab'));
  const screenImage = document.getElementById('screen-image');
  const screenLink = document.getElementById('screen-link');
  const screenTitle = document.getElementById('screen-title');
  const screenDescription = document.getElementById('screen-description');
  const screenIndex = document.getElementById('screen-index');
  const heroImage = document.getElementById('hero-preview-img');

  // 灯箱引用
  const lightboxModal = document.getElementById('lightbox-modal');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxBadge = document.getElementById('lightbox-badge');
  const lightboxTitle = document.getElementById('lightbox-title');
  const lightboxCloseBtn = document.getElementById('lightbox-close-btn');
  const lightboxBackdrop = document.getElementById('lightbox-backdrop');

  // 移动端菜单
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const primaryNav = document.getElementById('primary-nav');

  const themeButton = document.getElementById('theme-switch');
  const themeColorMeta = document.getElementById('theme-color');
  const THEME_KEY = 'strata-manager-site-theme';

  let activeScreenKey = wsTabs.find(tab => tab.classList.contains('active'))?.dataset.screen || 'models';
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

  // 渲染工作台屏幕
  function renderScreen(key) {
    if (!screens[key]) return;
    activeScreenKey = key;
    const item = screens[key];
    const copy = item[currentLang];
    const imagePath = new URL(`assets/screenshots/${key}.${currentLang}.webp`, siteRoot).href;

    // 平滑淡入淡出图片
    if (screenImage) {
      screenImage.style.opacity = '0.5';
      screenImage.onload = () => {
        screenImage.style.opacity = '1';
      };
      screenImage.src = imagePath;
      screenImage.alt = copy.alt;
      if (screenImage.complete && screenImage.naturalWidth > 0) screenImage.style.opacity = '1';
    }

    if (screenLink) {
      screenLink.href = imagePath;
      screenLink.dataset.target = key;
    }

    if (screenIndex) screenIndex.textContent = item.index;
    if (screenTitle) screenTitle.textContent = copy.title;
    if (screenDescription) screenDescription.textContent = copy.description;
    const screenPanel = document.getElementById('screen-panel');
    if (screenPanel) screenPanel.setAttribute('aria-labelledby', `tab-${key}`);

    wsTabs.forEach(tab => {
      const isSelected = tab.dataset.screen === key;
      tab.classList.toggle('active', isSelected);
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    });
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

    renderScreen(activeScreenKey);
    if (heroImage) heroImage.src = new URL(`assets/screenshots/overview.${currentLang}.webp`, siteRoot).href;
    if (lightboxModal.classList.contains('active')) openLightbox(lightboxModal.dataset.screen);
    updateThemeButton();

  }

  // 绑定工作台 Tab 事件（支持键盘方向键无障碍切换）
  wsTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      renderScreen(tab.dataset.screen);
    });

    tab.addEventListener('keydown', event => {
      let targetIndex = index;
      if (event.key === 'ArrowRight') {
        targetIndex = (index + 1) % wsTabs.length;
      } else if (event.key === 'ArrowLeft') {
        targetIndex = (index - 1 + wsTabs.length) % wsTabs.length;
      } else if (event.key === 'Home') {
        targetIndex = 0;
      } else if (event.key === 'End') {
        targetIndex = wsTabs.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      wsTabs[targetIndex].focus();
      renderScreen(wsTabs[targetIndex].dataset.screen);
    });
  });

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
  function openLightbox(screenKey) {
    const requestedKey = screenKey || activeScreenKey;
    const key = screens[requestedKey] ? requestedKey : 'models';
    const item = screens[key];
    const copy = item[currentLang];

    lightboxImg.src = new URL(`assets/screenshots/${key}.${currentLang}.webp`, siteRoot).href;
    lightboxImg.alt = copy.alt;
    lightboxBadge.textContent = item.index + ' / ' + key.toUpperCase();
    lightboxTitle.textContent = copy.title;

    if (!lightboxModal.classList.contains('active')) lightboxOpener = document.activeElement;
    lightboxModal.classList.add('active');
    lightboxModal.dataset.screen = key;
    lightboxModal.setAttribute('aria-hidden', 'false');
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
      gsap.from('.workspace-display-frame', { clipPath: 'inset(0 0 14% 0)', duration: .8, ease: 'power3.out', scrollTrigger: { trigger: '.workspace-display-frame', start: 'top 90%', once: true } });
      gsap.utils.toArray('.gallery-item').forEach(item => gsap.from(item, { y: 18, opacity: 0, duration: .5, ease: 'power3.out', scrollTrigger: { trigger: item, start: 'top 92%', once: true } }));
      gsap.from('.download-card', { x: -18, opacity: 0, duration: .5, stagger: .1, ease: 'power3.out', scrollTrigger: { trigger: '.download-cards-grid', start: 'top 90%', once: true } });
    });
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  }

  setLanguage(initialLanguage);
  animatePage();
  fetchLatestRelease();
})();
