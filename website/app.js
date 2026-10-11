/* Strata Manager · Modern Interactive Application Engine */
(() => {
  'use strict';

  // 网页多语言标题与多屏数据结构
  const pageTitles = {
    zh: 'Strata Manager · Strata 与本地模型服务管理',
    en: 'Strata Manager · Strata Runtimes & Local Model Services',
  };

  const screens = {
    overview: {
      index: '01',
      address: 'strata://manager/overview',
      zh: {
        title: '当前模型与服务，直接掌握。',
        description: '掌控当前活跃模型与服务状态，支持一键启停或释放内存，实时查看资源占用与近期请求。',
        alt: '总览：当前模型与配置、服务控制、资源和用量',
        badge: 'OVERVIEW 总览',
      },
      en: {
        title: 'Your active model and service, at a glance.',
        description: 'View active model and service status, toggle services, release memory, and monitor live resource usage.',
        alt: 'Overview: active model and configuration, service controls, resources, and usage',
        badge: 'OVERVIEW',
      },
    },
    runtime: {
      index: '02',
      address: 'strata://manager/runtime',
      zh: {
        title: '全局 Strata 安装与更新。',
        description: '检测本地环境与官方最新发布，查阅更新日志并一键执行 ZIP 平滑升级。',
        alt: 'Strata 管理：已安装运行环境、上游版本、ZIP 更新与版本日志',
        badge: 'STRATA 运行环境',
      },
      en: {
        title: 'Global Strata installation and updates.',
        description: 'Detect local and upstream runtimes, review release notes, and install official updates seamlessly.',
        alt: 'Strata management: installed runtime, upstream versions, ZIP updates, and release notes',
        badge: 'STRATA RUNTIME',
      },
    },
    chat: {
      index: '03',
      address: 'strata://manager/chat',
      zh: {
        title: '对话与上下文，触手可及。',
        description: '多轮会话管理与流式生成，支持图文附件、深度思考过程与 MCP 工具扩展。',
        alt: '聊天：多会话历史、流式回答、思考与附件',
        badge: 'CHAT 智能会话',
      },
      en: {
        title: 'Conversations & context, together.',
        description: 'Manage multi-turn chats with streaming responses, attachments, reasoning traces, and MCP tools.',
        alt: 'Chat: conversation history, streaming answers, reasoning, and attachments',
        badge: 'CHAT',
      },
    },
    models: {
      index: '04',
      address: 'strata://manager/models',
      zh: {
        title: '已有模型直接展示，运行配置随时切换。',
        description: '自动识别本地模型，合并同权重配置，清晰标记活跃状态并提供启动进度追踪。',
        alt: '模型：当前模型卡片、已有模型列表与多运行配置选择',
        badge: 'MODELS 模型资产',
      },
      en: {
        title: 'Discover models. Switch run configurations.',
        description: 'Discover local models, group shared-weight configurations, and track model load progress.',
        alt: 'Models: active model card, discovered assets, and multiple run configurations',
        badge: 'MODELS',
      },
    },
    config: {
      index: '05',
      address: 'strata://manager/models/config',
      zh: {
        title: '在模型内编辑完整运行配置。',
        description: '支持图形化表单与高级 JSON 双模编辑，保存配置副本并支持平滑热重启。',
        alt: '运行配置：模型内二级页面、图形化参数和完整 JSON 编辑',
        badge: 'CONFIG 运行配置',
      },
      en: {
        title: 'Edit the complete run configuration within Models.',
        description: 'Edit configurations via GUI forms or full JSON, save variants, and apply changes with smooth restarts.',
        alt: 'Run configuration: model subpage, graphical controls, and full JSON editing',
        badge: 'RUN CONFIGURATION',
      },
    },
    monitor: {
      index: '06',
      address: 'strata://manager/monitor',
      zh: {
        title: '查看硬件占用与请求状态。',
        description: '实时监测 GPU 负载、显存分配、CPU 占用、生成速度及当前请求队列。',
        alt: '性能监控：GPU 显存、计算负载与请求状态',
        badge: 'MONITOR 性能监控',
      },
      en: {
        title: 'Inspect hardware and request activity.',
        description: 'Monitor real-time GPU load, VRAM, CPU usage, generation speed, and request queues.',
        alt: 'Monitor: VRAM allocation, compute utilization, and request status',
        badge: 'MONITOR',
      },
    },
    usage: {
      index: '07',
      address: 'strata://manager/usage',
      zh: {
        title: '让日常使用与消耗，清晰有据。',
        description: '用量数据持久化本地留存，多维图表分析 Token 吞吐、生成速度与上下文缓存命中率。',
        alt: 'API 用量：持久化使用记录与请求、tokens、缓存、prefill、生成速度图表',
        badge: 'API USAGE 用量洞察',
      },
      en: {
        title: 'Understand everyday API activity.',
        description: 'Persistent local metrics with visual analytics for requests, tokens, throughput, and cache efficiency.',
        alt: 'API usage: persistent history and charts for requests, tokens, cache, prefill, and decode speed',
        badge: 'API USAGE',
      },
    },
    tuning: {
      index: '08',
      address: 'strata://manager/tuning',
      zh: {
        title: '比较结果，再决定是否应用。',
        description: '按典型场景实测基准测试，量化评估候选参数的延迟与显存收益，安全验证后再应用。',
        alt: '参数调优：完整场景、请求与重启参数、基线和候选比较',
        badge: 'TUNING 参数调优',
      },
      en: {
        title: 'Measure before applying.',
        description: 'Benchmark candidate parameters against baselines across real tasks before applying optimizations.',
        alt: 'Tuning: full scenarios, request and restart parameters, baseline and candidate comparison',
        badge: 'TUNING',
      },
    },
    settings: {
      index: '09',
      address: 'strata://manager/settings',
      zh: {
        title: '按使用习惯，设置你的工作台。',
        description: '个性化定制工作台，包括深浅色主题、系统托盘、后台守护行为与自动更新偏好。',
        alt: '设置：语言、主题、托盘、后台策略、自启动与更新检查',
        badge: 'SETTINGS 系统设置',
      },
      en: {
        title: 'Make the workspace fit your routine.',
        description: 'Customize your workspace: themes, system tray, background policy, and update preferences.',
        alt: 'Settings: language, theme, tray, background policy, startup, and update checks',
        badge: 'SETTINGS',
      },
    },
    about: {
      index: '10',
      address: 'strata://manager/settings/about',
      zh: {
        title: '版本、产品定位与社区信息。',
        description: '查阅桌面端版本信息与更新日志，了解开源项目架构与社区动态。',
        alt: '关于：产品定位、应用版本、版本说明、社区与开源许可',
        badge: 'ABOUT 关于',
      },
      en: {
        title: 'Version, product scope, and community.',
        description: 'View desktop version, release notes, source links, and open-source project info.',
        alt: 'About: product scope, application version, release notes, community, and licenses',
        badge: 'ABOUT',
      },
    },
  };

  // 提取需要国际化翻译的 DOM 元素
  const translatable = Array.from(document.querySelectorAll('[data-en]')).map(element => ({
    element,
    zh: element.textContent,
    en: element.dataset.en,
  }));

  const attributeTranslations = [
    ['data-alt-en', 'alt'],
    ['data-title-en', 'title'],
    ['data-label-en', 'aria-label'],
    ['data-content-en', 'content'],
    ['data-href-en', 'href'],
  ].flatMap(([dataAttribute, attribute]) =>
    Array.from(document.querySelectorAll(`[${dataAttribute}]`)).map(element => ({
      element,
      attribute,
      zh: element.getAttribute(attribute),
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
    if (themeColorMeta) themeColorMeta.content = next === 'light' ? '#f5f9f6' : '#06130e';
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
    const imagePath = `assets/screenshots/${key}.${currentLang}.webp`;

    // 平滑淡入淡出图片
    if (screenImage) {
      screenImage.style.opacity = '0.5';
      screenImage.src = imagePath;
      screenImage.alt = copy.alt;
      screenImage.onload = () => {
        screenImage.style.opacity = '1';
      };
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
  function setLanguage(nextLang, persist = false) {
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
    if (heroImage) heroImage.src = `assets/screenshots/runtime.${currentLang}.webp`;
    if (lightboxModal.classList.contains('active')) openLightbox(lightboxModal.dataset.screen);
    updateThemeButton();

    if (persist) {
      try {
        localStorage.setItem('strata-manager-site-language', currentLang);
      } catch (_) {}
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('lang', currentLang);
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      } catch (_) {}
    }
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
      setLanguage(currentLang === 'zh' ? 'en' : 'zh', true);
    });
  }

  // 全屏灯箱 (Lightbox) 交互控制
  function openLightbox(screenKey) {
    const requestedKey = screenKey || activeScreenKey;
    const key = screens[requestedKey] ? requestedKey : 'overview';
    const item = screens[key];
    const copy = item[currentLang];

    lightboxImg.src = `assets/screenshots/${key}.${currentLang}.webp`;
    lightboxImg.alt = copy.alt;
    lightboxBadge.textContent = item.index + ' / ' + key.toUpperCase();
    lightboxTitle.textContent = copy.title;

    lightboxModal.classList.add('active');
    lightboxModal.dataset.screen = key;
    lightboxModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightboxModal.classList.remove('active');
    lightboxModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
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
  });

  // 一键复制代码功能
  function setupCopyButton(btnId, codeSnippetId, originalLabel, copiedLabel) {
    const btn = document.getElementById(btnId);
    const codeEl = document.getElementById(codeSnippetId);
    if (!btn || !codeEl) return;

    btn.addEventListener('click', async () => {
      const textToCopy = codeEl.textContent.trim();
      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch (_) {
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      btn.classList.add('copied');
      const textSpan = btn.querySelector('.copy-text');
      if (textSpan) textSpan.textContent = currentLang === 'en' ? 'Copied!' : '已复制!';

      setTimeout(() => {
        btn.classList.remove('copied');
        if (textSpan) textSpan.textContent = currentLang === 'en' ? originalLabel.en : originalLabel.zh;
      }, 2000);
    });
  }

  setupCopyButton('copy-curl-btn', 'curl-code-snippet', { zh: '复制命令', en: 'Copy' }, { zh: '已复制!', en: 'Copied!' });
  setupCopyButton('copy-build-btn', 'build-code-snippet', { zh: '复制代码', en: 'Copy snippet' }, { zh: '已复制!', en: 'Copied!' });

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
  let initialLanguage = 'zh';
  try {
    const requested = new URLSearchParams(window.location.search).get('lang');
    if (requested === 'en' || requested === 'zh') {
      initialLanguage = requested;
    } else {
      const remembered = localStorage.getItem('strata-manager-site-language');
      if (remembered === 'en' || remembered === 'zh') initialLanguage = remembered;
    }
  } catch (_) {}

  // 集中维护 Releases 逻辑：动态拉取最新 Release，不写死版本号
  const GITHUB_REPO = 'hongfaqiu/strata-manager';
  const DEFAULT_RELEASE_TAG = 'v0.1.0-beta.1';
  let activeReleaseTag = DEFAULT_RELEASE_TAG;

  function buildAssetUrls(tag) {
    const cleanVersion = tag.replace(/^v/, '');
    const base = `https://github.com/${GITHUB_REPO}/releases/download/${tag}`;
    return {
      windows: `${base}/Strata.Manager_${cleanVersion}_x64-setup.exe`,
      appimage: `${base}/Strata.Manager_${cleanVersion}_amd64.AppImage`,
      deb: `${base}/Strata.Manager_${cleanVersion}_amd64.deb`,
      checksums: `${base}/SHA256SUMS`,
      notes: `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
    };
  }

  function applyRelease(tag, urls) {
    activeReleaseTag = tag;
    document.querySelectorAll('.release-version').forEach(el => {
      el.textContent = tag;
    });

    const winBtn = document.querySelector('[data-download="windows"]');
    if (winBtn && urls.windows) winBtn.href = urls.windows;

    const appImageBtn = document.querySelector('[data-download="appimage"]');
    if (appImageBtn && urls.appimage) appImageBtn.href = urls.appimage;

    const debBtn = document.querySelector('[data-download="deb"]');
    if (debBtn && urls.deb) debBtn.href = urls.deb;

    const checksumsBtn = document.querySelector('[data-download="checksums"]');
    if (checksumsBtn && urls.checksums) checksumsBtn.href = urls.checksums;

    const notesBtn = document.getElementById('release-notes-link');
    if (notesBtn && urls.notes) notesBtn.href = urls.notes;
  }

  async function fetchLatestRelease() {
    try {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=1`);
      if (!response.ok) return;
      const releases = await response.json();
      if (!Array.isArray(releases) || releases.length === 0) return;
      const release = releases[0];
      const tag = release.tag_name;
      if (!tag) return;

      const urls = {
        notes: release.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
      };

      if (Array.isArray(release.assets)) {
        for (const asset of release.assets) {
          const name = asset.name || '';
          if (name.endsWith('-setup.exe') || (name.endsWith('.exe') && name.includes('setup'))) {
            urls.windows = asset.browser_download_url;
          } else if (name.endsWith('.AppImage')) {
            urls.appimage = asset.browser_download_url;
          } else if (name.endsWith('.deb')) {
            urls.deb = asset.browser_download_url;
          } else if (name === 'SHA256SUMS') {
            urls.checksums = asset.browser_download_url;
          }
        }
      }

      const fallbackUrls = buildAssetUrls(tag);
      urls.windows = urls.windows || fallbackUrls.windows;
      urls.appimage = urls.appimage || fallbackUrls.appimage;
      urls.deb = urls.deb || fallbackUrls.deb;
      urls.checksums = urls.checksums || fallbackUrls.checksums;

      applyRelease(tag, urls);
    } catch (_) {}
  }

  setLanguage(initialLanguage);
  applyRelease(DEFAULT_RELEASE_TAG, buildAssetUrls(DEFAULT_RELEASE_TAG));
  fetchLatestRelease();
})();
