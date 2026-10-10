/* Strata Manager · Modern Interactive Application Engine */
(() => {
  'use strict';

  // 网页多语言标题与多屏数据结构
  const pageTitles = {
    zh: 'Strata Manager · 本地模型，一站管理',
    en: 'Strata Manager · Local Models. One Workspace.',
  };

  const screens = {
    overview: {
      index: '01',
      address: 'strata://manager/overview',
      zh: {
        title: '打开应用，全局态势一目了然。',
        description: '查看当前模型、后台服务、资源概况和近期用量，从这里进入聊天或管理模型。',
        alt: '总览：当前模型、后台服务、API 用量与资源概况',
        badge: 'OVERVIEW 总览',
      },
      en: {
        title: 'Open the app. Know what comes next.',
        description: 'Active model, background service health, resource consumption, and request throughput gathered in one place.',
        alt: 'Overview: active model, background service, API usage, and resources',
        badge: 'OVERVIEW',
      },
    },
    chat: {
      index: '02',
      address: 'strata://manager/chat',
      zh: {
        title: '对话与上下文，触手可及。',
        description: '多会话历史、流式回答与文本附件集中呈现；思考过程、图像输入和 MCP 工具事件取决于模型与运行时支持。',
        alt: '聊天：多会话历史、流式回答、思考与附件',
        badge: 'CHAT 智能会话',
      },
      en: {
        title: 'Conversations & context, together.',
        description: 'Conversation history, streaming replies and text attachments. Reasoning, image input and MCP events depend on model and runtime support.',
        alt: 'Chat: conversation history, streaming answers, reasoning, and attachments',
        badge: 'CHAT',
      },
    },
    models: {
      index: '03',
      address: 'strata://manager/models',
      zh: {
        title: '从已有资产，到新模型准备。',
        description: '检测或手动导入已有 Strata 安装，原有权重保持原位；通过准备向导添加新模型并查看任务进度。',
        alt: '模型：本机安装、模型准备与任务进度',
        badge: 'MODELS 模型资产',
      },
      en: {
        title: 'Keep what you have. Prepare what you need.',
        description: 'Detect or import an existing Strata installation without moving weights. Use guided preparation and task logs to add a model.',
        alt: 'Models: local installations, preparation wizard, and task logs',
        badge: 'MODELS',
      },
    },
    monitor: {
      index: '04',
      address: 'strata://manager/monitor',
      zh: {
        title: '查看硬件占用与请求状态。',
        description: '查看运行时提供的 GPU 负载、显存、CPU、生成速度和请求状态；可用指标取决于运行环境。',
        alt: '性能监控：GPU 显存、计算负载与请求状态',
        badge: 'MONITOR 性能监控',
      },
      en: {
        title: 'Inspect hardware and request activity.',
        description: 'Inspect GPU load, VRAM, CPU, generation speed and request status reported by the runtime. Available metrics depend on the environment.',
        alt: 'Monitor: VRAM allocation, compute utilization, and request status',
        badge: 'MONITOR',
      },
    },
    usage: {
      index: '05',
      address: 'strata://manager/usage',
      zh: {
        title: '让日常使用与消耗，清晰有据。',
        description: '查看请求趋势、tokens、成功率、等待时间与缓存读取量；采集不完整或不支持的数据会显示为未知。',
        alt: 'API 用量：请求趋势、tokens、成功率、等待时间与缓存',
        badge: 'API USAGE 用量洞察',
      },
      en: {
        title: 'Understand everyday API activity.',
        description: 'View request trends, tokens, success rate, latency and cache read tokens. Incomplete or unsupported data remains unknown.',
        alt: 'API usage: request trends, tokens, latency, and cache reads',
        badge: 'API USAGE',
      },
    },
    tuning: {
      index: '06',
      address: 'strata://manager/tuning',
      zh: {
        title: '比较结果，再决定是否应用。',
        description: '对受支持的 PCIe 预算和 MTP 推测参数执行基线与候选比较，检查吞吐、漂移和输出一致性；收益取决于模型与场景。',
        alt: '参数调优：场景选择、基线和候选比较',
        badge: 'TUNING 参数调优',
      },
      en: {
        title: 'Empirical benchmarks before committing.',
        description: 'Compare supported PCIe budget and MTP speculation parameters, reviewing throughput, baseline drift and output consistency. Gains depend on the model and workload.',
        alt: 'Tuning: measurement scenarios, baseline and candidate comparison',
        badge: 'TUNING',
      },
    },
    settings: {
      index: '07',
      address: 'strata://manager/settings',
      zh: {
        title: '按使用习惯，设置你的工作台。',
        description: '设置语言、主题、托盘与聊天偏好，调整轮询间隔、后台策略、登录自启动和更新检查。',
        alt: '设置：语言、主题、托盘、后台策略、自启动与更新检查',
        badge: 'SETTINGS 系统设置',
      },
      en: {
        title: 'Make the workspace fit your routine.',
        description: 'Choose language, theme, tray and chat preferences. Adjust polling, background policy, login startup and update checks.',
        alt: 'Settings: language, theme, tray, background policy, startup, and update checks',
        badge: 'SETTINGS',
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
  const screenAddressLabel = document.getElementById('screen-address-label');

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
    const imagePath = `assets/screenshots/${key}.zh.webp`;

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
    if (screenAddressLabel) screenAddressLabel.textContent = item.address;

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
    const key = screenKey || activeScreenKey;
    const item = screens[key] || screens.overview;
    const copy = item[currentLang];

    lightboxImg.src = `assets/screenshots/${key}.zh.webp`;
    lightboxImg.alt = copy.alt;
    lightboxBadge.textContent = item.index + ' / ' + key.toUpperCase();
    lightboxTitle.textContent = copy.title;

    lightboxModal.classList.add('active');
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

  setLanguage(initialLanguage);
})();
