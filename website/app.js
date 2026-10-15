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
      "image": "product-cover",
      "zh": {
        "title": "总览与服务状态。",
        "description": "查看总览及展开的服务状态面板；截图使用演示数据。",
        "alt": "Strata Manager 总览与已展开的服务状态弹层，包含模型、API 用量和运行指标的演示数据",
        "badge": "总览"
      },
      "en": {
        "title": "Overview and service status.",
        "description": "View the overview with its service status panel open; the screenshot uses demonstration data.",
        "alt": "Strata Manager overview with the service status popover open, showing demonstration model, API usage and runtime metrics",
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
      "image": "changelog/0.1.5/benchmark",
      "zh": { "title": "Benchmark · 上下文档位", "description": "在核验的上下文上限内，按档位串行测试并查看性能报告。", "alt": "Benchmark 上下文档位：模型上限、串行测试计划与输出预算", "badge": "基准测试" },
      "en": { "title": "Benchmark · Context tiers", "description": "Test tiers serially within the verified context limit and review performance reports.", "alt": "Benchmark context tiers: model limit, serial test plan and output allowance", "badge": "BENCHMARK" }
    },
    "scenario-benchmark": {
      "index": "04", "image": "changelog/0.1.5/scenario-benchmark",
      "zh": { "title": "Benchmark · 场景测试", "description": "七类场景固定串行执行，保留历史报告与导出。", "alt": "Benchmark 场景测试：场景选择、预热与重复次数", "badge": "场景测试" },
      "en": { "title": "Benchmark · Scenario suite", "description": "Run seven scenarios serially and keep report history and exports.", "alt": "Benchmark scenario suite: scenario selection, warmup and repetitions", "badge": "SCENARIO SUITE" }
    },
    "benchmark-report": {
      "index": "04", "image": "changelog/0.1.5/benchmark-report",
      "zh": { "title": "Benchmark · 结果报告", "description": "比较预填充、解码和请求耗时，复制图片或导出报告。", "alt": "Benchmark 结果报告：性能曲线与逐次结果，数值为演示数据而非实测", "badge": "测试报告", "height": 2720 },
      "en": { "title": "Benchmark · Results", "description": "Compare prefill, decode and request duration, then copy an image or export reports.", "alt": "Benchmark results: performance charts and individual samples with demonstration data, not measurements", "badge": "RESULTS", "height": 2800 }
    },
    "runtime": {
      "index": "05",
      "image": "changelog/0.1.5/runtime-download",
      "zh": { "title": "Strata · 下载来源与校验", "description": "选择官方来源、HTTPS 镜像或本地 ZIP，安装前核验完整包。", "alt": "Strata 运行环境下载：来源选择、本地 ZIP 与校验结果", "badge": "运行环境" },
      "en": { "title": "Strata · Download sources and verification", "description": "Choose the official source, an HTTPS mirror or a local ZIP and verify the complete package before installation.", "alt": "Strata runtime downloads: source selection, local ZIP and verification results", "badge": "RUNTIME" }
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
    "common-chat-settings": {
      "index": "10",
      "image": "changelog/0.1.5/common-chat-settings",
      "zh": { "title": "公共设置 · 按需继承参数", "description": "新模型默认继承，已有专用参数保留；更改在下一次聊天请求生效。", "alt": "公共聊天默认值：生成参数、MCP 开关与按模型继承选项", "badge": "公共设置" },
      "en": { "title": "Shared settings · Inherit when needed", "description": "New models inherit defaults; existing custom settings stay separate. Changes apply to the next chat request.", "alt": "Shared chat defaults: generation parameters, MCP and per-model inheritance", "badge": "SHARED SETTINGS" }
    },
    "connections": {
      "index": "11",
      "image": "changelog/0.1.5/connections",
      "zh": { "title": "连接 · 集中配置 API 与 MCP", "description": "选择连接目标、保存应用访问密钥，复制 API 和外部助手配置。", "alt": "API 与外部助手：连接目标、应用访问密钥、API 示例与 MCP 接入", "badge": "API 与外部助手" },
      "en": { "title": "Connections · API and MCP in one place", "description": "Choose a target, save the application's access key and copy API or assistant configurations.", "alt": "API and external assistants: connection targets, application access keys, API examples and MCP", "badge": "CONNECTIONS" }
    },
    "app-updates": {
      "index": "12",
      "image": "changelog/0.1.5/app-updates",
      "zh": { "title": "应用更新 · 先阅读，再确认", "description": "查看随应用打包的双语日志，检查新版本并确认签名更新。", "alt": "应用更新：当前版本、双语更新日志、检查与安装确认", "badge": "应用更新" },
      "en": { "title": "App updates · Read before confirming", "description": "Read bundled bilingual release notes, check for a new version and confirm signed updates.", "alt": "Application updates: current version, bilingual release notes, checks and installation confirmation", "badge": "APP UPDATES" }
    },
    "service-status": {
      "index": "13",
      "image": "changelog/0.1.5/service-status",
      "zh": { "title": "服务状态 · 查看近期趋势", "description": "区分生成与输入处理，保留采样间距和缺失点；空闲速度标明最近生成。", "alt": "服务状态快捷面板：当前状态、生成与输入处理的近期趋势", "badge": "服务状态" },
      "en": { "title": "Service status · See recent trends", "description": "Separate generation from input processing, retain sample gaps and label idle rates as recent generation.", "alt": "Service status panel: current state and recent generation and input-processing trends", "badge": "SERVICE STATUS" }
    },
    "floating-monitor": {
      "index": "14", "width": 440, "height": 80, "image": "changelog/0.1.5/floating-monitor",
      "zh": { "title": "独立浮条 · 紧凑监控", "description": "纯指标浮条支持任意位置拖动，操作集中在原生右键菜单与系统托盘。", "alt": "紧凑桌面监控浮条：服务状态与生成、输入处理指标", "badge": "桌面监控浮条" },
      "en": { "title": "Floating monitor · Compact metrics", "description": "Drag the metrics-only strip anywhere and use its native context menu or system tray for actions.", "alt": "Compact floating monitor: service status, generation and input-processing metrics", "badge": "FLOATING MONITOR" }
    },
    "floating-monitor-settings": {
      "index": "14", "image": "changelog/0.1.5/floating-monitor-settings",
      "zh": { "title": "浮条设置 · 显示与托盘", "description": "设置默认置顶、采样时间与系统托盘监控。", "alt": "监控浮动条设置：置顶、采样时间和系统托盘监控", "badge": "浮条设置" },
      "en": { "title": "Monitor settings · Display and tray", "description": "Set the default pin state, sample-time display and system tray monitoring.", "alt": "Floating monitor settings: pin state, sample time and system tray monitoring", "badge": "MONITOR SETTINGS" }
    },
    "overview-api-guide": {
      "index": "11", "image": "changelog/0.1.5/overview-api-guide",
      "zh": { "title": "API 接入 · 示例与帮助", "description": "从总览查看连接地址与 API 接入示例。", "alt": "总览页的 API 接入帮助和客户端请求示例", "badge": "API 接入" },
      "en": { "title": "API connections · Examples and help", "description": "Open connection details and API examples from the overview.", "alt": "API connection help and client request examples from the overview", "badge": "API GUIDE" }
    },
    "model-download-detail": {
      "index": "12", "image": "daily-experience/model-download-detail", "height": 2400,
      "zh": { "title": "模型 · 下载详情", "description": "统一显卡与运行选项，查看当前选择的资源估算和未知项。", "alt": "模型下载详情与资源选择，隔离示例数据", "badge": "模型下载" },
      "en": { "title": "Models · Download details", "description": "Unified GPU and run options with resource estimates and explicit unknowns.", "alt": "Model download details and resource selection, isolated example data", "badge": "MODELS" }
    },
    "api-verification": {
      "index": "13", "image": "daily-experience/api-verification",
      "zh": { "title": "API · 在线验证", "description": "显式发送一次限时限量的文本、工具结构或图片测试。", "alt": "API 在线验证，隔离示例数据", "badge": "API 验证" },
      "en": { "title": "API · Verification", "description": "Explicit bounded checks for text, tool structure or image input.", "alt": "API verification, isolated example data", "badge": "API CHECK" }
    },
    "history-comparison": {
      "index": "14", "image": "daily-experience/history-comparison",
      "zh": { "title": "Benchmark · 历史条件对照", "description": "查看历史数据与未知条件，不据弱身份宣称直接提速。", "alt": "历史 Benchmark 条件比较，隔离示例数据", "badge": "历史对照" },
      "en": { "title": "Benchmark · Historical conditions", "description": "Inspect historical values and unknown conditions without direct speedup claims from weak identity.", "alt": "Historical benchmark conditions, isolated example data", "badge": "HISTORY" }
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
  const lightboxDialog = lightboxModal?.querySelector('.lightbox-dialog');
  const lightboxBar = lightboxModal?.querySelector('.lightbox-bar');

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
    const imagePath = new URL(`assets/screenshots/${item.image || key}.${currentLang}.webp`, siteRoot).href;

    // 平滑淡入淡出图片
    if (screenImage) {
      screenImage.style.opacity = '0.5';
      screenImage.onload = () => {
        screenImage.style.opacity = '1';
      };
      screenImage.src = imagePath;
      screenImage.alt = copy.alt;
      screenImage.width = item.width || 2880;
      screenImage.height = copy.height || item.height || 1920;
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
    if (heroImage) heroImage.src = new URL(`assets/screenshots/product-cover.${currentLang}.webp`, siteRoot).href;
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
    const key = screens[requestedKey] ? requestedKey : 'models';
    const item = screens[key];
    const copy = item[currentLang];

    lightboxImg.src = new URL(`assets/screenshots/${item.image || key}.${currentLang}.webp`, siteRoot).href;
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
        ? (english ? 'No matching published release; showing a preview for manual installation.' : '暂无匹配的正式发布，以下为手工安装的预览构建。')
        : releaseState.snapshot
          ? (english ? 'Published release.' : '已发布版本。')
          : (english ? 'Latest published release.' : '最新已发布版本。');
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
