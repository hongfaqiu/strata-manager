/* Strata Manager · Modern Interactive Application Engine */
// Release catalog contract is independent of DOM and network state.
const strataReleaseCatalog = (() => {
  const repo = 'hongfaqiu/strata-manager';
  const base = `https://github.com/${repo}/releases`;
  const keys = ['windows', 'appimage', 'deb'];
  // DMG and the headless server packages are optional: a Windows/Linux desktop release stays complete without them.
  const optionalKeys = ['dmg', 'server', 'serverDeb'];

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
      dmg: `Strata.Manager_${clean}_aarch64.dmg`,
      server: `Strata.Manager.Server_${clean}_amd64.tar.gz`,
      serverDeb: `Strata.Manager.Server_${clean}_amd64.deb`,
    };
    const result = { notes: release.html_url };
    for (const key of [...keys, ...optionalKeys]) {
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
    for (const key of [...keys, ...optionalKeys]) {
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

  return Object.freeze({ repo, keys, optionalKeys, version, compare, select, selectResponses, assets, applyDownloads });
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
        "title": "总览 · 服务与硬件一屏可见。",
        "description": "服务状态与启停、显存和内存占用、生成速度、最近请求与今日 API 集中在一页，异常时先看到提示。",
        "alt": "Strata Manager 总览：服务操作栏、GPU 与系统内存占用图、生成速度、最近请求和今日 API",
        "badge": "总览"
      },
      "en": {
        "title": "Overview · Service and hardware at a glance.",
        "description": "Service controls, VRAM and memory use, generation speed, recent requests and today's API usage on one page, with issues surfaced first.",
        "alt": "Strata Manager overview: service controls, GPU and system memory map, generation speed, recent requests and today's API usage",
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
      "image": "benchmark",
      "zh": { "title": "Benchmark · 上下文档位", "description": "在核验的上下文上限内，按档位串行测试并查看性能报告。", "alt": "Benchmark 上下文档位：模型上限、串行测试计划与输出预算", "badge": "基准测试" },
      "en": { "title": "Benchmark · Context tiers", "description": "Test tiers serially within the verified context limit and review performance reports.", "alt": "Benchmark context tiers: model limit, serial test plan and output allowance", "badge": "BENCHMARK" }
    },
    "scenario-benchmark": {
      "index": "04", "image": "scenario-benchmark",
      "zh": { "title": "Benchmark · 场景测试", "description": "七类场景固定串行执行，保留历史报告与导出。", "alt": "Benchmark 场景测试：场景选择、预热与重复次数", "badge": "场景测试" },
      "en": { "title": "Benchmark · Scenario suite", "description": "Run seven scenarios serially and keep report history and exports.", "alt": "Benchmark scenario suite: scenario selection, warmup and repetitions", "badge": "SCENARIO SUITE" }
    },
    "benchmark-report": {
      "index": "04", "image": "benchmark-report",
      "zh": { "title": "Benchmark · 结果报告", "description": "比较预填充、解码和请求耗时，复制图片或导出报告。", "alt": "Benchmark 结果报告：性能曲线与逐次结果，数值为演示数据而非实测", "badge": "测试报告", "height": 2720 },
      "en": { "title": "Benchmark · Results", "description": "Compare prefill, decode and request duration, then copy an image or export reports.", "alt": "Benchmark results: performance charts and individual samples with demonstration data, not measurements", "badge": "RESULTS", "height": 2800 }
    },
    "runtime": {
      "index": "05",
      "image": "runtime-download-settings",
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
      "zh": { "title": "调优 · 比较参数配置", "description": "按任务比较质量、速度与资源占用。", "alt": "参数调优：快速校准、场景验收与并发对比", "badge": "参数调优" },
      "en": { "title": "Tuning · Compare configurations", "description": "Compare quality, speed and resource use for a workload.", "alt": "Parameter tuning: quick calibration, scenario checks and concurrency comparison", "badge": "TUNING" }
    },
    "settings": {
      "index": "09",
      "zh": { "title": "设置 · 调整工作台偏好", "description": "语言、外观、托盘与更新偏好。", "alt": "应用设置：语言、外观、后台与更新选项", "badge": "应用偏好" },
      "en": { "title": "Settings · Make it your workspace", "description": "Language, appearance, tray and update preferences.", "alt": "Application settings: language, appearance, background and update options", "badge": "SETTINGS" }
    },
    "common-chat-settings": {
      "index": "10",
      "image": "common-chat-settings",
      "zh": { "title": "公共设置 · 按需继承参数", "description": "新模型默认继承，已有专用参数保留；更改在下一次聊天请求生效。", "alt": "公共聊天默认值：生成参数、MCP 开关与按模型继承选项", "badge": "公共设置" },
      "en": { "title": "Shared settings · Inherit when needed", "description": "New models inherit defaults; existing custom settings stay separate. Changes apply to the next chat request.", "alt": "Shared chat defaults: generation parameters, MCP and per-model inheritance", "badge": "SHARED SETTINGS" }
    },
    "connections": {
      "index": "11",
      "image": "connections",
      "zh": { "title": "连接 · 集中配置 API 与 MCP", "description": "选择连接目标、保存应用访问密钥，复制 API 和外部助手配置。", "alt": "API 与外部助手：连接目标、应用访问密钥、API 示例与 MCP 接入", "badge": "API 与外部助手" },
      "en": { "title": "Connections · API and MCP in one place", "description": "Choose a target, save the application's access key and copy API or assistant configurations.", "alt": "API and external assistants: connection targets, application access keys, API examples and MCP", "badge": "CONNECTIONS" }
    },
    "app-updates": {
      "index": "12",
      "image": "app-updates",
      "zh": { "title": "应用更新 · 先阅读，再确认", "description": "查看随应用打包的双语日志，检查新版本并确认签名更新。", "alt": "应用更新：当前版本、双语更新日志、检查与安装确认", "badge": "应用更新" },
      "en": { "title": "App updates · Read before confirming", "description": "Read bundled bilingual release notes, check for a new version and confirm signed updates.", "alt": "Application updates: current version, bilingual release notes, checks and installation confirmation", "badge": "APP UPDATES" }
    },
    "service-status": {
      "index": "13",
      "image": "service-status",
      "zh": { "title": "服务状态 · 查看近期趋势", "description": "区分生成与输入处理，保留采样间距和缺失点；空闲速度标明最近生成。", "alt": "服务状态快捷面板：当前状态、生成与输入处理的近期趋势", "badge": "服务状态" },
      "en": { "title": "Service status · See recent trends", "description": "Separate generation from input processing, retain sample gaps and label idle rates as recent generation.", "alt": "Service status panel: current state and recent generation and input-processing trends", "badge": "SERVICE STATUS" }
    },
    "floating-monitor": {
      "index": "14", "width": 440, "height": 80, "image": "floating-monitor",
      "zh": { "title": "独立浮条 · 紧凑监控", "description": "纯指标浮条支持任意位置拖动，操作集中在原生右键菜单；Windows 上可收起到任务栏监控。", "alt": "紧凑桌面监控浮条：服务状态与生成、输入处理指标", "badge": "桌面监控浮条" },
      "en": { "title": "Floating monitor · Compact metrics", "description": "Drag the metrics-only strip anywhere and use its native context menu for actions; on Windows it can collapse into the taskbar monitor.", "alt": "Compact floating monitor: service status, generation and input-processing metrics", "badge": "FLOATING MONITOR" }
    },
    "floating-monitor-settings": {
      "index": "14", "image": "floating-monitor-settings",
      "zh": { "title": "浮条设置 · 布局与显示", "description": "设置布局、字号、指标顺序、默认置顶与采样时间。", "alt": "监控浮动条设置：布局、字号、指标顺序、置顶和采样时间", "badge": "浮条设置" },
      "en": { "title": "Monitor settings · Layout and display", "description": "Set the layout, text size, metric order, default pin state and sample-time display.", "alt": "Floating monitor settings: layout, text size, metric order, pin state and sample time", "badge": "MONITOR SETTINGS" }
    },
    "overview-api-guide": {
      "index": "11", "image": "overview-api-guide",
      "zh": { "title": "API 接入 · 示例与帮助", "description": "从总览查看连接地址与 API 接入示例。", "alt": "总览页的 API 接入帮助和客户端请求示例", "badge": "API 接入" },
      "en": { "title": "API connections · Examples and help", "description": "Open connection details and API examples from the overview.", "alt": "API connection help and client request examples from the overview", "badge": "API GUIDE" }
    },

    "model-download-list": {
      "index": "12", "image": "daily-experience/model-download-list",
      "zh": { "title": "模型 · 下载列表", "description": "先在列表选择模型，再进入详情配置。", "alt": "模型下载列表，隔离示例数据", "badge": "模型下载" },
      "en": { "title": "Models · Download list", "description": "Pick a model in the list, then open details.", "alt": "Model download list, isolated example data", "badge": "MODELS" }
    },
    "startup-diagnostic": {
      "index": "12", "image": "daily-experience/startup-diagnostic",
      "zh": { "title": "启动 · 失败诊断", "description": "查看阶段、耗时、原因和脱敏证据。", "alt": "启动失败诊断，隔离示例数据", "badge": "启动诊断" },
      "en": { "title": "Startup · Diagnostics", "description": "See phase, duration, reason and redacted evidence.", "alt": "Startup failure diagnostics, isolated example data", "badge": "DIAGNOSTICS" }
    },
    "service-capabilities": {
      "index": "12", "image": "daily-experience/service-capabilities",
      "zh": { "title": "能力 · 可用与未核验", "description": "区分可用、不支持、未核验和需要重启。", "alt": "服务能力四态，隔离示例数据", "badge": "服务能力" },
      "en": { "title": "Capabilities · Ready and unchecked", "description": "Available, unsupported, unchecked or needs restart.", "alt": "Service capability states, isolated example data", "badge": "CAPABILITIES" }
    },
    "chat-execution": {
      "index": "12", "image": "daily-experience/chat-execution",
      "zh": { "title": "聊天 · 请求计时", "description": "等待、思考、工具和正文分开计时。", "alt": "聊天请求计时，隔离示例数据", "badge": "聊天计时" },
      "en": { "title": "Chat · Request timing", "description": "Waiting, thinking, tools and body stay separate.", "alt": "Chat request timing, isolated example data", "badge": "TIMING" }
    },
    "api-usage": {
      "index": "12", "image": "daily-experience/api-usage",
      "zh": { "title": "用量 · 请求与 tokens", "description": "请求、tokens、延迟和缓存复用趋势。", "alt": "API 用量趋势，隔离示例数据", "badge": "API 用量" },
      "en": { "title": "Usage · Requests and tokens", "description": "Requests, tokens, latency and cache reuse.", "alt": "API usage trends, isolated example data", "badge": "USAGE" }
    },
    "onboarding": {
      "index": "12", "image": "onboarding",
      "zh": { "title": "开始使用 · 分步引导", "description": "从检查环境到第一次聊天，按本机内存选模型。", "alt": "开始使用引导，隔离示例数据", "badge": "开始使用" },
      "en": { "title": "Get started · Step-by-step guide", "description": "From environment checks to the first chat, with models filtered by this computer's memory.", "alt": "Getting started guide, isolated example data", "badge": "GET STARTED" }
    },
    "config-cleanup": {
      "index": "12", "image": "config-cleanup",
      "zh": { "title": "模型 · 旧版本配置清理", "description": "把旧版本运行配置移入可恢复的归档。", "alt": "旧版本配置清理，隔离示例数据", "badge": "多版本配置" },
      "en": { "title": "Models · Clean up old-version configurations", "description": "Move old run configurations into a restorable archive.", "alt": "Old-version configuration cleanup, isolated example data", "badge": "MULTI-VERSION" }
    },
    "arena": {
      "index": "04", "image": "arena",
      "zh": { "title": "Benchmark · 排行榜", "description": "同模型、同量化对比不同硬件，可筛选并切换排序。", "alt": "Benchmark 排行榜，示例数据", "badge": "排行榜" },
      "en": { "title": "Benchmark · Leaderboard", "description": "Compare the same model and quantization across hardware, with filters and sorting.", "alt": "Benchmark leaderboard, example data", "badge": "LEADERBOARD" }
    },
    "running-services": {
      "index": "15", "image": "running-services",
      "zh": { "title": "服务 · 运行中实例", "description": "查看加载状态、模型、配置和 API 地址。", "alt": "运行中服务状态与连接", "badge": "运行中服务" },
      "en": { "title": "Services · Running instances", "description": "See loaded state, model, config and API URL.", "alt": "Running services status and connection", "badge": "RUNNING" }
    },
    "language-settings": {
      "index": "16", "image": "language-settings",
      "zh": { "title": "语言 · 跟随系统或随包资源", "description": "十种随包语言，也可跟随系统。", "alt": "界面语言与系统跟随", "badge": "语言" },
      "en": { "title": "Language · System or bundled packs", "description": "Ten bundled languages, or follow the system.", "alt": "Interface language and system follow", "badge": "LANGUAGE" }
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
    "runtime-overview": {
      "index": "05", "image": "runtime",
      "zh": { "title": "Strata · 运行环境与更新", "description": "识别本机硬件与已装 Strata，选择运行环境、检查更新并按官方长度和 SHA256 校验。", "alt": "Strata 运行环境：硬件、已安装版本、运行目录与更新", "badge": "运行环境" },
      "en": { "title": "Strata · Runtime and updates", "description": "Detect hardware and installed Strata, choose a runtime, check for updates and verify size and SHA256.", "alt": "Strata runtime: hardware, installed version, runtime folder and updates", "badge": "RUNTIME" }
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

  // Stage tabs map to rebuilt app views.
  const stageViews = {
    overview: { screen: 'overview', title: { zh: '总览', en: 'Overview' } },
    models: { screen: 'models', title: { zh: '模型', en: 'Models' } },
    monitor: { screen: 'monitor', title: { zh: '监控', en: 'Monitor' } },
    usage: { screen: 'usage', title: { zh: '监控', en: 'Monitor' } },
    chat: { screen: 'chat', title: { zh: '聊天', en: 'Chat' } },
    runtime: { screen: 'runtime-overview', title: { zh: 'Strata', en: 'Strata' } },
  };
  const sidebarScreens = { benchmark: 'benchmark', tuning: 'tuning', settings: 'settings' };

  const copy = {
    zh: {
      verdict: { fits: '可在本机运行，显存约余 {free} GB。', tight: '可以运行，但显存只剩约 {free} GB，长上下文会更慢。', over: '超出本机显存与内存，建议换更小的量化。' },
      checking: '正在检查…', upToDate: '已是最新 · SHA256 校验通过', copied: '已复制',
      download: '下载', left: '约剩 {n} 分钟', verifying: '正在校验大小与 SHA256…', downloaded: '已下载 · 大小与 SHA256 校验通过',
      boostStep: '第 {i}/{n} 步', boostClock: '已用 {t} · 约剩 {n} 分钟',
      cherry: 'Provider   OpenAI 兼容\nAPI 地址   http://127.0.0.1:19001/v1\nAPI 密钥   strata-local\n模型       Swift-Qwen3.8-Flash-Next',
    },
    en: {
      verdict: { fits: 'Runs on this computer with about {free} GB of VRAM to spare.', tight: 'Runs, but only about {free} GB of VRAM is left; long contexts will be slower.', over: 'Exceeds this computer\u2019s VRAM and memory. Pick a smaller quantization.' },
      checking: 'Checking…', upToDate: 'Up to date · SHA256 verified', copied: 'Copied',
      download: 'Download', left: 'about {n} min left', verifying: 'Verifying size and SHA256…', downloaded: 'Downloaded · size and SHA256 verified',
      boostStep: 'Step {i} of {n}', boostClock: '{t} elapsed · about {n} min left',
      cherry: 'Provider   OpenAI-compatible\nAPI host   http://127.0.0.1:19001/v1\nAPI key    strata-local\nModel      Swift-Qwen3.8-Flash-Next',
    },
  };
  const clientConfigs = {
    cursor: () => "export OPENAI_BASE_URL='http://127.0.0.1:19001/v1'\nexport OPENAI_API_KEY='strata-local'\nexport OPENAI_MODEL='Swift-Qwen3.8-Flash-Next'\ncursor .",
    codex: () => '# ~/.codex/config.toml\nmodel_provider = "strata"\nmodel = "Swift-Qwen3.8-Flash-Next"\n\n[model_providers.strata]\nname = "Strata (local)"\nbase_url = "http://127.0.0.1:19001/v1"\nenv_key = "STRATA_API_KEY"\nwire_api = "chat"',
    claude: () => "export ANTHROPIC_BASE_URL='http://127.0.0.1:19001'\nexport ANTHROPIC_AUTH_TOKEN='strata-local'\nexport ANTHROPIC_MODEL='Swift-Qwen3.8-Flash-Next'\nclaude",
    cherry: () => copy[currentLang].cherry,
  };

  // Text that switches language (static HTML already carries both).
  const translatable = Array.from(document.querySelectorAll('[data-en]')).map(element => ({
    element,
    zh: element.getAttribute('data-zh') ?? element.textContent,
    en: element.dataset.en,
  }));
  const attributeTranslations = [
    ['data-alt-en', 'alt'], ['data-title-en', 'title'], ['data-label-en', 'aria-label'],
    ['data-content-en', 'content'], ['data-href-en', 'href'], ['data-src-en', 'src'],
  ].flatMap(([dataAttribute, attribute]) =>
    Array.from(document.querySelectorAll(`[${dataAttribute}]`)).map(element => ({
      element, attribute,
      zh: element.getAttribute(dataAttribute.replace(/-en$/, '-zh')) ?? element.getAttribute(attribute),
      en: element.getAttribute(dataAttribute),
    }))
  );

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionAllowed = () => !reduceMotion.matches;

  const languageButton = $('#language-switch');
  const languageLabel = $('#language-label');
  const wsTabs = $$('.ws-tab');
  const appWindow = $('#app-window');
  const appFit = $('[data-app-fit]');
  const appTitle = $('#app-title');
  const screenTitle = $('#screen-title');
  const screenDescription = $('#screen-description');
  const screenIndex = $('#screen-index');
  const screenPanel = $('#screen-panel');

  const mobileMenuBtn = $('#mobile-menu-btn');
  const primaryNav = $('#primary-nav');
  const themeButton = $('#theme-switch');
  const themeColorMeta = $('#theme-color');
  const THEME_KEY = 'strata-manager-site-theme';

  let activeView = wsTabs.find(tab => tab.classList.contains('active'))?.dataset.screen || 'overview';
  let currentLang = 'zh';

  function currentTheme() { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; }
  function updateThemeButton() {
    if (!themeButton) return;
    const toLight = currentTheme() === 'dark';
    const label = currentLang === 'en' ? (toLight ? 'Switch to light mode' : 'Switch to dark mode') : (toLight ? '切换到亮色模式' : '切换到黑夜模式');
    themeButton.setAttribute('aria-label', label);
    themeButton.title = label;
  }
  function applyTheme(theme, persist = false) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    if (themeColorMeta) themeColorMeta.content = next === 'light' ? '#f7f6f2' : '#14120f';
    if (persist) { try { localStorage.setItem(THEME_KEY, next); } catch (_) {} }
    updateThemeButton();
  }

  // ---------- App mockup: scale to fit, switch views ----------
  function fitApp() {
    if (!appFit || !appWindow) return;
    const width = appFit.clientWidth;
    if (!width) return;
    const compact = width < 700;
    appWindow.classList.toggle('is-compact', compact);
    const designWidth = compact ? 680 : 1120;
    const designHeight = compact ? 860 : 700;
    const scale = Math.min(1.1, width / designWidth);
    appWindow.style.transform = `scale(${scale})`;
    appWindow.style.marginLeft = `${Math.max(0, (width - designWidth * scale) / 2)}px`;
    appFit.style.height = `${designHeight * scale}px`;
    appFit.classList.add('is-scaled');
  }
  if (appFit && typeof ResizeObserver !== 'undefined') new ResizeObserver(fitApp).observe(appFit);
  window.addEventListener('resize', fitApp);

  function renderScreen(key, { animate = false, auto = false } = {}) {
    const view = stageViews[key];
    if (!view || !appWindow) return;
    activeView = key;
    const item = screens[view.screen];
    const text = item[currentLang];
    appWindow.dataset.view = key;
    $$('.app-view', appWindow).forEach(section => {
      const on = section.dataset.view === key;
      section.hidden = !on;
      section.classList.toggle('is-active', on);
      section.classList.remove('is-entering');
      if (on && animate && motionAllowed()) { void section.offsetWidth; section.classList.add('is-entering'); }
    });
    const navTarget = key === 'usage' ? 'monitor' : key;
    $$('.app-nav', appWindow).forEach(button => button.classList.toggle('is-active', button.dataset.goto === navTarget));
    if (appTitle) appTitle.textContent = view.title[currentLang];
    if (screenIndex) screenIndex.textContent = item.index;
    if (screenTitle) screenTitle.textContent = text.title;
    if (screenDescription) screenDescription.textContent = text.description;
    screenPanel?.setAttribute('aria-labelledby', `tab-${key}`);
    wsTabs.forEach(tab => {
      const selected = tab.dataset.screen === key;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    onViewShown(key, auto);
  }

  wsTabs.forEach((tab, index) => {
    tab.addEventListener('click', event => { if (event.isTrusted) hero?.interrupt(); renderScreen(tab.dataset.screen, { animate: true }); });
    tab.addEventListener('keydown', event => {
      const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: wsTabs.length - 1 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      const target = wsTabs[(moves[event.key] + wsTabs.length) % wsTabs.length];
      target.focus();
      hero?.interrupt();
      renderScreen(target.dataset.screen, { animate: true });
    });
  });
  $$('.app-nav', appWindow || document).forEach(button => button.addEventListener('click', () => {
    const goto = button.dataset.goto;
    if (stageViews[goto]) renderScreen(goto, { animate: true });
    else if (sidebarScreens[goto]) openLightbox(sidebarScreens[goto]);
  }));
  const monitorSeg = $$('.app-view[data-view="monitor"] .m-seg span');
  const usageSeg = $$('.app-view[data-view="usage"] > .m-seg span');
  if (monitorSeg[1]) monitorSeg[1].addEventListener('click', () => renderScreen('usage', { animate: true }));
  if (usageSeg[0]) usageSeg[0].addEventListener('click', () => renderScreen('monitor', { animate: true }));

  // Copy the endpoint for real.
  $$('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const label = button.querySelector('span');
    const original = label?.textContent;
    try { await navigator.clipboard.writeText(button.dataset.copy); } catch (_) { return; }
    if (label) label.textContent = copy[currentLang].copied;
    button.classList.add('is-done');
    setTimeout(() => { if (label) label.textContent = original; button.classList.remove('is-done'); }, 1400);
  }));

  // ---------- Demo runner: scripted loops that only advance while visible ----------
  // Each demo plays a short script on repeat. Time stops while the demo is off-screen,
  // hovered or the tab is hidden; a real click hands control to the visitor and the
  // loop restarts after a quiet period. Reduced motion shows the finished state.
  const STOP = Symbol('stop');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const runners = [];
  function createRunner(root, { play, final, onInterrupt, resumeAfter = 9000, threshold = 0.3 }) {
    let gen = 0, running = false, visible = false, hovered = false, held = false, paused = false, timer = null;
    const runner = {
      get active() { return visible && !hovered && !held && !paused && !document.hidden; },
      get running() { return running; },
      get paused() { return paused; },
      get held() { return held; },
      async wait(ms, g) {
        let left = ms, last = performance.now();
        while (left > 0) {
          if (g !== gen) throw STOP;
          await wait(Math.min(50, left));
          const now = performance.now();
          if (runner.active) left -= now - last;
          last = now;
        }
        if (g !== gen) throw STOP;
      },
      start() {
        if (running || paused || held || !visible || !motionAllowed()) return;
        running = true;
        const g = ++gen;
        (async () => {
          try { for (;;) await play(g); }
          catch (error) { if (error !== STOP) console.error(error); }
          finally { if (g === gen) running = false; }
        })();
      },
      stop() { gen += 1; running = false; },
      interrupt() {
        if (!motionAllowed()) return;
        runner.stop();
        held = true;
        onInterrupt?.();
        clearTimeout(timer);
        timer = setTimeout(() => { held = false; changed(); runner.start(); }, resumeAfter);
        changed();
      },
      pause() { runner.stop(); paused = true; held = false; clearTimeout(timer); onInterrupt?.(); changed(); },
      resume() { paused = false; held = false; clearTimeout(timer); changed(); runner.start(); },
      init() {
        root.addEventListener('pointerenter', event => { if (event.pointerType !== 'mouse') return; hovered = true; root.classList.add('is-hovered'); });
        root.addEventListener('pointerleave', () => { hovered = false; root.classList.remove('is-hovered'); });
        if (!motionAllowed()) final?.();
        if ('IntersectionObserver' in window) {
          new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (visible) runner.start(); }, { threshold }).observe(root);
        } else { visible = true; runner.start(); }
        reduceMotion.addEventListener?.('change', () => { if (motionAllowed()) runner.start(); else { runner.stop(); final?.(); } changed(); });
      },
    };
    const changed = () => root.dispatchEvent(new CustomEvent('demo-state'));
    runners.push(runner);
    return runner;
  }
  // A fake pointer that glides to an element and "clicks" it.
  function makePointer(container) {
    const element = container && $('[data-pointer]', container);
    return {
      hide() { element?.classList.remove('is-on'); },
      async move(target, runner, g, ms = 760) {
        if (!element || !target || !target.getClientRects().length) return false;
        const box = container.getBoundingClientRect();
        const scale = box.width / container.offsetWidth || 1;
        const rect = target.getBoundingClientRect();
        const x = (rect.left - box.left + rect.width * 0.5) / scale;
        const y = (rect.top - box.top + rect.height * 0.55) / scale;
        element.classList.add('is-on');
        element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        await runner.wait(ms, g);
        return true;
      },
      async click(target, runner, g) {
        await this.move(target, runner, g);
        if (!target) return;
        if (element) { element.classList.remove('is-click'); void element.offsetWidth; element.classList.add('is-click'); }
        target.classList.add('is-pressed');
        await runner.wait(220, g);
        target.classList.remove('is-pressed');
      },
    };
  }

  // ---------- Hero app: service state and live telemetry ----------
  const svcLabels = {
    zh: { stopped: '未启动', loading: '启动中', idle: '空闲', generating: '生成中' },
    en: { stopped: 'Not started', loading: 'Starting', idle: 'Idle', generating: 'Generating' },
  };
  let svc = 'generating';
  // Bottom status bar: same states and wording as the desktop ServiceTelemetryStatusBar.
  const sbLabels = {
    zh: { connecting: '正在连接', detected: '检测到运行中服务', stopped: '服务未启动', loading: '正在载入模型', reading: '读取中', idle: '空闲', generating: '生成中' },
    en: { connecting: 'Connecting', detected: 'Running service detected', stopped: 'Service not started', loading: 'Loading model', reading: 'Reading', idle: 'Idle', generating: 'Generating' },
  };
  const sbSpeedLabels = { zh: { reading: '读取', idle: '最近生成', generating: '生成' }, en: { reading: 'Reading', idle: 'Last generation', generating: 'Generation' } };
  const statusbar = $('[data-statusbar]');
  let sbState = 'generating', lastTps = 104.6, prefill = 3184, temp = 58, cpu = 12;
  const gpuHist = Array.from({ length: 24 }, (_, i) => 84 + Math.sin(i * 0.8) * 4);
  const sbSet = (key, value) => { const element = statusbar && $(`[data-sb-${key}]`, statusbar); if (element) element.textContent = value; };
  function setStatusbar(state) {
    sbState = state;
    if (!statusbar) return;
    statusbar.dataset.state = state;
    sbSet('label', sbLabels[currentLang][state] ?? '');
    paintStatusbar();
  }
  function paintStatusbar() {
    if (!statusbar) return;
    const state = sbState;
    const speed = state === 'generating' ? tps : state === 'reading' ? prefill : state === 'idle' ? lastTps : 0;
    sbSet('speed-label', sbSpeedLabels[currentLang][state] ?? '');
    sbSet('speed', speed > 0.05 ? speed.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–');
    sbSet('running', state === 'generating' || state === 'reading' ? '1' : '0');
    const queued = state === 'generating' ? 1 : 0;
    sbSet('queued', String(queued));
    $('[data-sb-queued]', statusbar)?.classList.toggle('is-warn', queued > 0);
    sbSet('cpu', String(cpu));
    sbSet('temp', String(temp));
  }
  // Service-status popover (opened from the top pill) and the floating strip (opened from the status bar).
  const popover = $('[data-svc-popover]');
  const popAnchor = $('[data-pop-anchor]');
  const floatStrip = $('[data-float]');
  const floatButton = $('[data-sb-float]');
  const sparkPath = (values, max) => {
    const points = values.map((value, i) => `${(4 + i / (values.length - 1) * 152).toFixed(1)} ${(44 - Math.max(0, Math.min(1, value / max)) * 38).toFixed(1)}`);
    return `M${points.join(' L')}`;
  };
  function paintPopover() {
    if (popover && !popover.hidden) {
      $('[data-pop-spark="tps"]', popover)?.setAttribute('d', sparkPath(spark, 124));
      $('[data-pop-spark="gpu"]', popover)?.setAttribute('d', sparkPath(gpuHist, 100));
      const used = Math.max(1, vram);
      const vramText = $('[data-pop-vram]', popover); if (vramText) vramText.textContent = `${used.toFixed(1)} / 32.0 GB`;
      const vramBar = $('[data-pop-vram-bar]', popover); if (vramBar) vramBar.style.width = `${(used / 32 * 100).toFixed(1)}%`;
      const context = 33152 + (genTokens % 512);
      const ctx = $('[data-pop-ctx]', popover); if (ctx) ctx.textContent = context.toLocaleString('en-US');
      const ctxBar = $('[data-pop-ctx-bar]', popover); if (ctxBar) ctxBar.style.width = `${(context / 131072 * 100).toFixed(1)}%`;
      const stamp = $('[data-pop-time]', popover); if (stamp) stamp.textContent = time(clock + tick % 60);
      const title = $('[data-pop-speed-title]', popover); if (title) title.textContent = currentLang === 'en' ? 'Generation speed trend' : '生成速度趋势';
    }
    if (floatStrip && !floatStrip.hidden) {
      const gen = $('[data-float-gen]', floatStrip); if (gen) gen.textContent = tps > 0.05 ? tps.toFixed(1) : '—';
      const fv = $('[data-float-vram]', floatStrip); if (fv) fv.textContent = Math.max(1, vram).toFixed(1);
      setLive('load2f', String(load));
    }
  }
  function showPopover(on) {
    if (!popover) return;
    popover.hidden = !on;
    popover.classList.toggle('is-open', on);
    popAnchor?.classList.toggle('is-on', on);
    paintPopover();
  }
  function showFloat(on) {
    if (!floatStrip) return;
    floatStrip.hidden = !on;
    floatStrip.classList.toggle('is-open', on);
    floatButton?.classList.toggle('is-on', on);
    paintPopover();
  }
  popAnchor?.addEventListener('click', event => { event.stopPropagation(); showPopover(popover?.hidden ?? false); });
  floatButton?.addEventListener('click', () => showFloat(floatStrip?.hidden ?? false));
  const live = name => $$(`[data-live="${name}"]`);
  const setLive = (name, value) => live(name).forEach(element => {
    const first = element.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) first.nodeValue = value;
    else element.insertBefore(document.createTextNode(value), first);
  });
  const spark = Array.from({ length: 24 }, (_, i) => 104 - i * 0.2 + Math.sin(i * 0.9) * 2.4);
  let tps = 104.6, load = 86, power = 265, vram = 21, genTokens = 140, clock = 14 * 3600 + 34 * 60 + 31, requestTotal = 128, tick = 0;
  const overviewSpark = $('.app-view[data-view="overview"] .m-spark');
  function drawSpark() {
    if (!overviewSpark) return;
    const min = 0, max = 124;
    const points = spark.map((value, i) => `${(i / (spark.length - 1) * 300).toFixed(1)} ${(58 - (value - min) / (max - min) * 52).toFixed(1)}`);
    overviewSpark.querySelector('.line').setAttribute('d', `M${points.join(' L')}`);
    overviewSpark.querySelector('.area').setAttribute('d', `M${points.join(' L')} L300 60 L0 60 Z`);
  }
  function paintTelemetry() {
    const shown = tps > 0.05 ? tps.toFixed(1) : '—';
    setLive('tps', tps > 0.05 ? String(Math.round(tps)) : '—');
    ['tps1', 'tps2'].forEach(name => setLive(name, shown));
    setLive('pill-tps', `${shown} tok/s`);
    // The chat timing line keeps the finished request's speed instead of decaying with the service.
    if (svc === 'generating') setLive('chat-tps', `${shown} tok/s`);
    ['load', 'load2', 'load3'].forEach(name => setLive(name, String(load)));
    ['power', 'power2', 'power3'].forEach(name => setLive(name, String(power)));
    setLive('vram', String(Math.round(vram)));
    setLive('gen-tokens', `${Math.min(genTokens, 512)} tokens · ${shown} tok/s`);
    live('gen-bar').forEach(bar => { bar.style.width = `${Math.min(100, genTokens / 5.12)}%`; });
    drawSpark();
    paintStatusbar();
    paintPopover();
  }
  function setSvc(state) {
    svc = state;
    if (!appWindow) return;
    appWindow.dataset.svc = state;
    $$('[data-svc-label]', appWindow).forEach(element => { element.textContent = svcLabels[currentLang][state]; });
    $$('[data-svc-badge]', appWindow).forEach(element => {
      element.classList.toggle('is-live', state === 'idle' || state === 'generating');
      element.classList.toggle('is-starting', state === 'loading');
    });
    $$('.m-states [data-state]', appWindow).forEach(element => element.classList.toggle('is-on', element.dataset.state === state));
    if (state === 'stopped') { tps = 0; load = 0; vram = 1; }
    if (svc !== 'generating' && tps > 1) lastTps = tps;
    setStatusbar(state);
    paintTelemetry();
  }
  const loadBar = $('[data-load-bar]');
  const loadText = $('[data-load-text]');
  function setLoad(percent) {
    if (loadBar) loadBar.style.width = `${percent}%`;
    if (loadText) loadText.textContent = `${(83.6 * percent / 100).toFixed(1)} / 83.6 GB`;
    vram = 1 + 20 * percent / 100;
    setLive('vram', String(Math.round(vram)));
  }
  const requests = $('[data-requests]');
  const time = seconds => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  function pushRequest(speed = Math.max(tps, 98 + Math.random() * 6)) {
    if (!requests) return;
    clock += 20;
    requestTotal += 1;
    const row = document.createElement('li');
    row.className = 'is-new';
    row.innerHTML = `<i></i><span>${time(clock)}</span><span>4,096 → 384</span><span>${speed.toFixed(1)} <small>tok/s</small></span>`;
    requests.prepend(row);
    while (requests.children.length > 6) requests.lastElementChild.remove();
    setLive('reqs', String(requestTotal));
  }
  function telemetryTick() {
    tick += 1;
    const generating = svc === 'generating';
    // RTX 4080 SUPER example: decode settles around 100–110 tok/s.
    const target = generating ? 101 + Math.random() * 8 : 0;
    tps += (target - tps) * (generating ? 0.6 : 0.55);
    if (!generating && tps < 0.6) tps = 0;
    const targetLoad = sbState === 'reading' ? 72 : { stopped: 0, loading: 24, idle: 3, generating: 86 }[svc];
    load = Math.max(0, Math.round(load + (targetLoad + (Math.random() - 0.5) * (generating ? 8 : 2) - load) * 0.5));
    const targetPower = sbState === 'reading' ? 220 : { stopped: 18, loading: 120, idle: 34, generating: 265 }[svc];
    power = Math.max(0, Math.round(power + (targetPower + (Math.random() - 0.5) * 10 - power) * 0.5));
    if (generating) genTokens = genTokens >= 512 ? 0 : genTokens + Math.round(tps * 0.6);
    if (generating && tps > 1) lastTps = tps;
    temp = Math.round(temp + (({ stopped: 38, loading: 47, idle: 45, generating: 60 })[svc] + (Math.random() - 0.5) * 2 - temp) * 0.3);
    cpu = Math.max(1, Math.round(cpu + (({ stopped: 3, loading: 22, idle: 4, generating: 12 })[svc] + (Math.random() - 0.5) * 4 - cpu) * 0.5));
    prefill = 3100 + Math.random() * 180;
    spark.push(tps); spark.shift();
    gpuHist.push(load); gpuHist.shift();
    paintTelemetry();
    // When the visitor is driving, keep requests trickling in on their own.
    if (generating && tick % 4 === 0 && !(hero && hero.running)) pushRequest();
  }
  let telemetryTimer = null;
  let stageVisible = false;
  function updateTelemetry() {
    const run = stageVisible && motionAllowed() && !document.hidden;
    if (run && !telemetryTimer) telemetryTimer = setInterval(telemetryTick, 600);
    if (!run && telemetryTimer) { clearInterval(telemetryTimer); telemetryTimer = null; }
  }
  drawSpark();
  document.addEventListener('visibilitychange', updateTelemetry);
  reduceMotion.addEventListener?.('change', updateTelemetry);

  // ---------- API usage chart ----------
  const bars = $('[data-bars]');
  const series = {
    req: i => 0.25 + 0.6 * Math.abs(Math.sin(i * 0.34 + 0.6)) + (i === 47 ? 0.9 : 0),
    tok: i => 0.3 + 0.55 * Math.abs(Math.sin(i * 0.28 + 1.4)) + 0.1 * Math.sin(i * 1.7),
    lat: i => 0.45 + 0.25 * Math.sin(i * 0.5) + 0.12 * Math.cos(i * 1.3),
    tps: i => 0.62 + 0.12 * Math.sin(i * 0.4 + 2) + 0.05 * Math.cos(i * 2.1),
  };
  function renderBars(metric) {
    if (!bars) return;
    if (!bars.children.length) bars.innerHTML = Array.from({ length: 48 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
    Array.from(bars.children).forEach((bar, i) => bar.style.setProperty('--h', Math.round(Math.min(1, series[metric](i) / 1.8 * 1.7) * 100)));
  }
  renderBars('req');
  $$('[data-metric-switch] button').forEach(button => button.addEventListener('click', () => {
    $$('[data-metric-switch] button').forEach(other => other.classList.toggle('is-on', other === button));
    renderBars(button.dataset.metric);
  }));
  function bumpUsage() {
    const last = bars?.lastElementChild;
    if (!last) return;
    last.style.setProperty('--h', Math.min(100, (Number(last.style.getPropertyValue('--h')) || 40) + 10));
    last.classList.remove('is-bump'); void last.offsetWidth; last.classList.add('is-bump');
  }

  // ---------- Chat: type, send, stream ----------
  const answer = $('[data-stream]');
  const chatScroll = $('.m-chat-scroll');
  const composer = $('[data-composer]');
  const composerText = $('[data-composer-text]');
  const question = $('[data-chat-q]');
  const streamTargets = answer ? $$('li, code, p', answer) : [];
  const fullText = element => element.dataset.full ?? (element.dataset.full = element.textContent);
  function clearComposer() {
    composer?.classList.remove('has-text', 'is-typing');
    if (composerText) composerText.textContent = '';
  }
  function chatFinal() {
    streamTargets.forEach(element => { if (element.dataset.full !== undefined) element.textContent = element.dataset.full; element.removeAttribute('data-pending'); element.classList.remove('is-typing'); });
    answer?.querySelector('pre')?.removeAttribute('data-pending');
    chatScroll?.classList.remove('is-empty', 'is-waiting');
    clearComposer();
  }
  function chatReset() {
    streamTargets.forEach(element => { fullText(element); element.textContent = ''; element.setAttribute('data-pending', ''); element.classList.remove('is-typing'); });
    answer?.querySelector('pre')?.setAttribute('data-pending', '');
    chatScroll?.classList.add('is-empty');
    chatScroll?.classList.remove('is-waiting', 'is-sent');
    clearComposer();
  }
  async function typeQuestion(runner, g) {
    if (!composer || !question) return;
    const chars = Array.from(question.textContent);
    const step = currentLang === 'en' ? 2 : 1;
    composer.classList.add('has-text', 'is-typing');
    for (let i = 0; i < chars.length; i += step) {
      composerText.textContent = chars.slice(0, i + step).join('');
      await runner.wait(currentLang === 'en' ? 30 : 58, g);
    }
    composer.classList.remove('is-typing');
  }
  function sendQuestion() {
    clearComposer();
    chatScroll?.classList.remove('is-empty');
    chatScroll?.classList.add('is-waiting', 'is-sent');
  }
  async function streamReply(runner, g) {
    chatScroll?.classList.remove('is-waiting');
    for (const element of streamTargets) {
      if (element.tagName === 'CODE') answer.querySelector('pre')?.removeAttribute('data-pending');
      element.removeAttribute('data-pending');
      element.classList.add('is-typing');
      const chars = Array.from(fullText(element));
      // Paced near ~100 tok/s (about 100 Chinese or 250 English characters per second) while staying readable.
      const step = currentLang === 'en' ? 5 : 2;
      for (let i = 0; i < chars.length; i += step) {
        element.textContent = chars.slice(0, i + step).join('');
        await runner.wait(element.tagName === 'CODE' ? 14 : 20, g);
      }
      element.classList.remove('is-typing');
      await runner.wait(130, g);
    }
  }

  // ---------- Runtime: check for updates ----------
  const verify = $('[data-verify]');
  $('[data-verify-run]')?.addEventListener('click', () => {
    if (!verify || verify.classList.contains('is-running')) return;
    const text = $('[data-verify-text]', verify);
    verify.classList.add('is-running');
    text.textContent = copy[currentLang].checking;
    setTimeout(() => {
      verify.classList.remove('is-running');
      text.textContent = copy[currentLang].upToDate;
      const latest = $('[data-latest]');
      if (latest) latest.textContent = '0.1.43';
    }, motionAllowed() ? 1700 : 0);
  });

  function onViewShown(key, auto) {
    if (key === 'usage' && bars && motionAllowed()) { bars.classList.remove('is-grow'); void bars.offsetWidth; bars.classList.add('is-grow'); }
    if (key === 'chat' && !auto) chatFinal();
  }

  // ---------- Hero autoplay: start a model, chat with it, watch it work ----------
  const heroPointer = makePointer(appWindow);
  const navButton = key => $(`.app-nav[data-goto="${key}"]`, appWindow);
  const showView = key => renderScreen(key, { animate: true, auto: true });
  const hero = screenPanel && appWindow ? createRunner(screenPanel, {
    threshold: 0.2,
    resumeAfter: 10000,
    async play(g) {
      const w = ms => hero.wait(ms, g);
      await w(500);
      heroPointer.hide();
      chatReset(); setLoad(0); showPopover(false); showFloat(false); setSvc('stopped'); setStatusbar('connecting'); showView('models');
      await w(900);
      setStatusbar('stopped');
      await w(900);
      await heroPointer.click($('[data-demo-start]', appWindow), hero, g);
      setSvc('loading');
      for (let percent = 0; percent <= 100; percent += 2.5) { setLoad(percent); sbSet('elapsed', String(Math.round(percent * 0.38))); await w(55); }
      setSvc('idle');
      await w(900);
      await heroPointer.click(navButton('chat'), hero, g); showView('chat');
      await w(600);
      await heroPointer.move(composer, hero, g);
      await typeQuestion(hero, g);
      await w(260);
      await heroPointer.click($('[data-chat-send]', appWindow), hero, g);
      sendQuestion(); setStatusbar('reading'); load = 68; power = 205; paintTelemetry();
      await w(800);
      setSvc('generating');
      await streamReply(hero, g);
      pushRequest(); setSvc('idle');
      await w(1500);
      await heroPointer.click(navButton('monitor'), hero, g); showView('monitor');
      genTokens = 0; setSvc('generating');
      await w(3200);
      await heroPointer.click($$('.app-view[data-view="monitor"] .m-seg span')[1], hero, g); showView('usage');
      await w(900);
      pushRequest(); bumpUsage();
      await w(2400);
      setSvc('idle');
      await heroPointer.click(navButton('overview'), hero, g); showView('overview');
      await w(900);
      // Status checks: the top pill opens the service-status panel; the status bar opens the floating strip.
      setSvc('generating');
      await heroPointer.click(popAnchor, hero, g); showPopover(true);
      await w(3400);
      showPopover(false);
      await heroPointer.click(floatButton, hero, g); showFloat(true);
      await w(3200);
      heroPointer.hide();
      showFloat(false);
      await w(1600);
    },
    final() { heroPointer.hide(); chatFinal(); setLoad(100); showPopover(false); showFloat(false); setSvc('generating'); },
    onInterrupt() { heroPointer.hide(); chatFinal(); setLoad(100); showPopover(false); showFloat(false); if (svc === 'stopped' || svc === 'loading') setSvc('generating'); else setStatusbar(svc); },
  }) : null;
  const demoToggle = $('#demo-toggle');
  const demoToggleLabel = $('[data-demo-label]');
  function updateDemoToggle() {
    if (!demoToggle || !hero) return;
    demoToggle.hidden = !motionAllowed();
    const stopped = hero.paused || hero.held;
    demoToggle.setAttribute('aria-pressed', String(hero.paused));
    demoToggle.classList.toggle('is-held', hero.held);
    if (demoToggleLabel) demoToggleLabel.textContent = stopped ? (currentLang === 'en' ? 'Play demo' : '继续演示') : (currentLang === 'en' ? 'Pause demo' : '暂停演示');
  }
  demoToggle?.addEventListener('click', () => { if (hero.paused || hero.held) hero.resume(); else hero.pause(); });
  screenPanel?.addEventListener('demo-state', updateDemoToggle);
  // Any real click or keyboard focus inside the app takes over from the script.
  screenPanel?.addEventListener('click', event => { if (event.isTrusted) hero?.interrupt(); }, true);
  screenPanel?.addEventListener('focusin', () => hero?.interrupt());

  // ---------- Feature demo: pick a quantization, then download ----------
  const fitDemo = $('[data-fit-demo]');
  let fitRunner = null;
  if (fitDemo) {
    const options = $$('.fit-opt', fitDemo);
    const pointer = makePointer(fitDemo);
    const dl = $('[data-dl]', fitDemo);
    const dlBar = $('[data-dl-bar]', fitDemo);
    const dlText = $('[data-dl-text]', fitDemo);
    const dlLabel = $('[data-dl-label]', fitDemo);
    const dlButton = $('[data-dl-btn]', fitDemo);
    const select = option => {
      options.forEach(other => { const on = other === option; other.classList.toggle('is-on', on); other.setAttribute('aria-checked', String(on)); other.tabIndex = on ? 0 : -1; });
      const vram = Number(option.dataset.vram);
      const ram = Number(option.dataset.ram);
      const verdict = option.dataset.verdict;
      const level = verdict === 'over' ? 'is-err' : verdict === 'tight' ? 'is-warn' : '';
      [['vram', vram, 32], ['ram', ram, 96]].forEach(([name, value, total]) => {
        const bar = $(`[data-fit="${name}"]`, fitDemo);
        bar.style.width = `${(value / total) * 100}%`;
        bar.className = level;
        $(`[data-fit-label="${name}"]`, fitDemo).textContent = verdict === 'over' && name === 'vram' ? `> ${total} GB` : `${value} / ${total} GB`;
      });
      const box = $('[data-fit-verdict]', fitDemo);
      box.className = `fit-verdict ${level}`;
      box.textContent = copy[currentLang].verdict[verdict].replace('{free}', String(32 - vram));
      if (dlLabel) dlLabel.textContent = `${copy[currentLang].download} · ${option.dataset.size} GB`;
    };
    const setDownload = (state, percent = 0) => {
      dl.dataset.state = state;
      const text = copy[currentLang];
      if (state === 'idle') { dlBar.style.width = '0%'; dlText.textContent = ''; }
      if (state === 'run') {
        dlBar.style.width = `${percent}%`;
        const minutes = Math.max(1, Math.ceil((100 - percent) / 100 * 83.6 * 1024 / 412 / 60));
        dlText.textContent = `${(83.6 * percent / 100).toFixed(1)} / 83.6 GB · 412 MB/s · ${text.left.replace('{n}', minutes)}`;
      }
      if (state === 'verify') { dlBar.style.width = '100%'; dlText.textContent = text.verifying; }
      if (state === 'done') { dlBar.style.width = '100%'; dlText.textContent = text.downloaded; }
    };
    fitRunner = createRunner(fitDemo, {
      async play(g) {
        const w = ms => fitRunner.wait(ms, g);
        await w(400);
        pointer.hide(); select(options[0]); setDownload('idle');
        await w(900);
        for (const index of [2, 1, 0]) {
          await pointer.click(options[index], fitRunner, g); select(options[index]);
          await w(index ? 1500 : 900);
        }
        await pointer.click(dlButton, fitRunner, g);
        for (let percent = 0; percent <= 100; percent += 1.25) { setDownload('run', percent); await w(55); }
        setDownload('verify'); await w(1000);
        setDownload('done'); pointer.hide();
        await w(3200);
      },
      final() { pointer.hide(); select(options[0]); setDownload('done'); },
      onInterrupt() { pointer.hide(); if (dl.dataset.state !== 'idle') setDownload('done'); },
    });
    options.forEach((option, index) => {
      option.tabIndex = option.classList.contains('is-on') ? 0 : -1;
      const choose = () => { fitRunner.interrupt(); select(option); setDownload(index === 0 ? 'done' : 'idle'); };
      option.addEventListener('click', event => { if (event.isTrusted) choose(); });
      option.addEventListener('keydown', event => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        const next = options[(index + delta + options.length) % options.length];
        next.focus(); next.click();
      });
    });
    fitDemo.refreshLanguage = () => { const on = options.find(option => option.classList.contains('is-on')); if (on) select(on); setDownload(dl.dataset.state, 100); };
  }

  // ---------- Feature demo: connect a client, then verify the API ----------
  const connectDemo = $('[data-connect-demo]');
  let connectRunner = null;
  if (connectDemo) {
    const pointer = makePointer(connectDemo);
    const config = $('[data-client-config]', connectDemo);
    const clientTabs = $$('[data-client]', connectDemo);
    const steps = $$('[data-steps] li', connectDemo);
    const result = $('[data-verify-result]', connectDemo);
    const runButton = $('[data-steps-run]', connectDemo);
    let manualRun = 0;
    const setClient = tab => clientTabs.forEach(other => { const on = other === tab; other.classList.toggle('is-on', on); other.setAttribute('aria-selected', String(on)); });
    const resetSteps = () => { steps.forEach(step => { step.classList.remove('is-ok', 'is-run'); step.querySelector('em').textContent = ''; }); result?.classList.remove('is-on'); };
    async function runSteps(pause) {
      resetSteps();
      for (const step of steps) {
        step.classList.add('is-run');
        await pause(480);
        step.classList.replace('is-run', 'is-ok');
        step.querySelector('em').textContent = step.dataset.stepTime;
      }
      await pause(200);
      result?.classList.add('is-on');
    }
    const runManual = () => {
      const run = ++manualRun;
      runSteps(async ms => { await wait(motionAllowed() ? ms : 0); if (run !== manualRun) throw STOP; }).catch(() => {});
    };
    async function typeConfig(text, g) {
      const caret = '<span class="caret"></span>';
      for (let i = 0; i <= text.length; i += 3) {
        config.textContent = text.slice(0, i);
        config.insertAdjacentHTML('beforeend', caret);
        await connectRunner.wait(16, g);
      }
      config.textContent = text;
    }
    connectRunner = createRunner(connectDemo, {
      async play(g) {
        const w = ms => connectRunner.wait(ms, g);
        for (const tab of clientTabs) {
          await w(600);
          await pointer.click(tab, connectRunner, g);
          setClient(tab); resetSteps();
          await typeConfig(clientConfigs[tab.dataset.client](), g);
          await w(400);
          await pointer.click(runButton, connectRunner, g);
          await runSteps(w);
          await w(2200);
        }
      },
      final() { pointer.hide(); setClient(clientTabs[0]); config.textContent = clientConfigs.cursor(); runManual(); },
      onInterrupt() { pointer.hide(); const on = clientTabs.find(tab => tab.classList.contains('is-on')) || clientTabs[0]; config.textContent = clientConfigs[on.dataset.client](); },
    });
    clientTabs.forEach(tab => tab.addEventListener('click', event => {
      if (!event.isTrusted) return;
      connectRunner.interrupt();
      setClient(tab);
      config.textContent = clientConfigs[tab.dataset.client]();
      runManual();
    }));
    runButton?.addEventListener('click', event => { if (!event.isTrusted) return; connectRunner.interrupt(); runManual(); });
  }

  // ---------- Feature demo: one-click speed-up ----------
  const boostDemo = $('[data-boost-demo]');
  let boostRunner = null;
  if (boostDemo) {
    const pointer = makePointer(boostDemo);
    const steps = $$('[data-boost-steps] li', boostDemo);
    const stepLabel = $('[data-boost-step]', boostDemo);
    const timeLabel = $('[data-boost-time]', boostDemo);
    const sparkPath = $('[data-boost-spark]', boostDemo);
    const samples = [];
    const setPhase = phase => { boostDemo.dataset.phase = phase; };
    const drawBoost = () => {
      const points = samples.map((value, i) => `${(i / 59 * 300).toFixed(1)} ${(44 - (value - 84) / 28 * 40).toFixed(1)}`);
      sparkPath?.setAttribute('d', points.length ? `M${points.join(' L')}` : 'M0 30');
    };
    const clockText = progress => {
      const elapsed = Math.round(progress * 580);
      const left = Math.max(1, Math.ceil((600 - elapsed) / 60));
      const stamp = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
      return copy[currentLang].boostClock.replace('{t}', stamp).replace('{n}', left);
    };
    boostRunner = createRunner(boostDemo, {
      async play(g) {
        const w = ms => boostRunner.wait(ms, g);
        await w(400);
        pointer.hide(); setPhase('idle');
        await w(1500);
        await pointer.click($('[data-boost-start]', boostDemo), boostRunner, g);
        setPhase('run'); pointer.hide();
        samples.length = 0; drawBoost();
        steps.forEach(step => step.classList.remove('is-run', 'is-ok'));
        for (let index = 0; index < steps.length; index += 1) {
          steps[index].classList.add('is-run');
          stepLabel.textContent = copy[currentLang].boostStep.replace('{i}', index + 1).replace('{n}', steps.length);
          for (let k = 0; k < 12; k += 1) {
            const base = index < 2 ? 92.4 : (k % 2 ? 104.8 : 92.8);
            samples.push(base + (Math.random() - 0.5) * 4);
            if (samples.length > 60) samples.shift();
            drawBoost();
            timeLabel.textContent = clockText((index * 12 + k) / (steps.length * 12));
            await w(110);
          }
          steps[index].classList.replace('is-run', 'is-ok');
        }
        setPhase('done');
        await w(2600);
        await pointer.click($('[data-boost-apply]', boostDemo), boostRunner, g);
        setPhase('applied'); pointer.hide();
        await w(3600);
      },
      final() { pointer.hide(); setPhase('applied'); },
      onInterrupt() { pointer.hide(); setPhase('applied'); },
    });
  }

  // ---------- Feature demo: floating monitor ----------
  const monitorDemo = $('[data-monitor-demo]');
  let monitorRunner = null;
  if (monitorDemo) {
    const scales = { gen: 130, pre: 4000, gpu: 100, vram: 32, cpu: 100, ram: 96 };
    const values = { gen: 104, pre: 0, gpu: 86, vram: 21, cpu: 12, ram: 62 };
    const history = Object.fromEntries(Object.keys(scales).map(key => [key, Array.from({ length: 40 }, (_, i) => {
      const preset = { gen: 102 + Math.sin(i * 0.7) * 4, pre: i % 13 === 3 ? 3200 : 0, gpu: 84 + Math.sin(i) * 4, vram: 21, cpu: 11 + Math.sin(i * 1.3) * 2, ram: 62 }[key];
      return Math.max(0, preset);
    })]));
    const format = { gen: v => v > 0.4 ? v.toFixed(0) : '0', pre: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0), gpu: v => v.toFixed(0), vram: v => v.toFixed(1), cpu: v => v.toFixed(0), ram: v => v.toFixed(1) };
    const stateBadge = $('[data-mon-state]', monitorDemo);
    const stateLabel = $('[data-mon-label]', monitorDemo);
    const reqText = $('[data-mon-req]', monitorDemo);
    const reqBar = $('[data-mon-bar]', monitorDemo);
    const log = $('[data-mon-log]', monitorDemo);
    let monClock = 14 * 3600 + 34 * 60 + 31;
    const clients = [['cursor', '2,310 → 512'], ['codex', '6,144 → 256'], ['claude-code', '4,096 → 384'], ['chat', '820 → 256']];
    let clientIndex = 0;
    const paint = () => {
      Object.keys(scales).forEach(key => {
        const span = $(`[data-mon="${key}"]`, monitorDemo);
        if (span) span.textContent = format[key](values[key]);
        const path = $(`[data-mon-line="${key}"]`, monitorDemo);
        const points = history[key].map((value, i) => `${(i / 39 * 120).toFixed(1)} ${(22 - Math.min(1, value / scales[key]) * 20).toFixed(1)}`);
        path?.setAttribute('d', `M${points.join(' L')}`);
      });
    };
    const sample = () => { Object.keys(scales).forEach(key => { history[key].push(values[key]); history[key].shift(); }); paint(); };
    const setState = generating => {
      stateBadge?.classList.toggle('is-live', generating);
      if (stateLabel) stateLabel.textContent = svcLabels[currentLang][generating ? 'generating' : 'idle'];
    };
    const ease = (key, target, k = 0.4, noise = 0) => { values[key] += (target + (Math.random() - 0.5) * noise - values[key]) * k; };
    monitorRunner = createRunner(monitorDemo, {
      async play(g) {
        const w = ms => monitorRunner.wait(ms, g);
        setState(false); reqText.textContent = '—'; reqBar.style.width = '0%';
        for (let i = 0; i < 8; i += 1) { ease('gen', 0, 0.6); ease('pre', 0, 0.7); ease('gpu', 3, 0.5, 2); ease('cpu', 6, 0.5, 2); sample(); await w(200); }
        setState(true);
        const [client, shape] = clients[clientIndex++ % clients.length];
        for (let i = 0; i < 5; i += 1) { ease('pre', 3200, 0.7, 260); ease('gpu', 97, 0.6, 3); ease('cpu', 24, 0.5, 4); sample(); await w(200); }
        values.pre = 0;
        let tokens = 0;
        while (tokens < 384) {
          ease('gen', 105, 0.45, 7); ease('gpu', 86, 0.5, 6); ease('cpu', 12, 0.5, 3); ease('pre', 0, 0.8);
          tokens = Math.min(384, tokens + values.gen * 0.2); // 200 ms per sample
          reqText.textContent = `${Math.round(tokens)} tokens`;
          reqBar.style.width = `${tokens / 3.84}%`;
          sample(); await w(200);
        }
        monClock += 20;
        const row = document.createElement('li');
        row.className = 'is-new';
        row.innerHTML = `<span>${time(monClock)}</span><span>${client}</span><span>${shape}</span><span>${values.gen.toFixed(1)} t/s</span>`;
        log.prepend(row);
        while (log.children.length > 3) log.lastElementChild.remove();
      },
      final() { setState(true); paint(); },
    });
    paint();
  }

  // ---------- Feature demo: benchmark tiers, then the leaderboard ----------
  const boardDemo = $('[data-board-demo]');
  let benchRunner = null;
  function sortBoard(metric) {
    if (!boardDemo) return;
    const list = $('[data-board]', boardDemo);
    const rows = $$('li', list);
    const visibleRows = rows.filter(row => !row.classList.contains('is-pending'));
    const max = Math.max(...visibleRows.map(row => Number(row.dataset[metric])));
    const before = new Map(rows.map(row => [row, row.getBoundingClientRect().top]));
    rows.sort((a, b) => Number(b.dataset[metric]) - Number(a.dataset[metric])).forEach(row => list.append(row));
    visibleRows.sort((a, b) => Number(b.dataset[metric]) - Number(a.dataset[metric])).forEach((row, index) => {
      row.firstElementChild.textContent = String(index + 1);
      row.querySelector('[data-val]').textContent = metric === 'decode' ? Number(row.dataset.decode).toFixed(1) : Number(row.dataset.prefill).toLocaleString('en-US');
      row.querySelector('i b').style.width = `${(Number(row.dataset[metric]) / max) * 100}%`;
    });
    if (!motionAllowed()) return;
    rows.forEach(row => {
      const delta = before.get(row) - row.getBoundingClientRect().top;
      if (!delta || row.classList.contains('is-pending')) return;
      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => { row.style.transition = ''; row.style.transform = ''; });
    });
  }
  if (boardDemo) {
    const pointer = makePointer(boardDemo);
    const sortButtons = $$('[data-sort]', boardDemo);
    const tabs = $$('[data-bench-tab]', boardDemo);
    const tiers = $$('[data-tiers] li', boardDemo);
    const progress = $('[data-bench-progress]', boardDemo);
    const mine = $('.board-rows .is-mine', boardDemo);
    const setPane = pane => { boardDemo.dataset.pane = pane; tabs.forEach(tab => tab.classList.toggle('is-on', tab.dataset.benchTab === pane)); };
    const setSort = metric => { sortButtons.forEach(other => { const on = other.dataset.sort === metric; other.classList.toggle('is-on', on); other.setAttribute('aria-pressed', String(on)); }); sortBoard(metric); };
    const fillTier = (tier, done) => { tier.querySelector('[data-c="pre"]').textContent = done ? tier.dataset.pre : '—'; tier.querySelector('[data-c="dec"]').textContent = done ? tier.dataset.dec : '—'; };
    const showAll = () => { tiers.forEach(tier => { tier.classList.remove('is-wait', 'is-run'); fillTier(tier, true); }); if (progress) progress.textContent = `${tiers.length} / ${tiers.length}`; mine?.classList.remove('is-pending'); };
    benchRunner = createRunner(boardDemo, {
      async play(g) {
        const w = ms => benchRunner.wait(ms, g);
        await w(400);
        pointer.hide(); setPane('tiers');
        tiers.forEach(tier => { tier.classList.remove('is-run'); tier.classList.add('is-wait'); fillTier(tier, false); });
        if (progress) progress.textContent = `0 / ${tiers.length}`;
        mine?.classList.add('is-pending'); setSort('decode');
        await w(900);
        for (let index = 0; index < tiers.length; index += 1) {
          tiers[index].classList.replace('is-wait', 'is-run');
          await w(1100);
          tiers[index].classList.remove('is-run'); fillTier(tiers[index], true);
          if (progress) progress.textContent = `${index + 1} / ${tiers.length}`;
        }
        await w(700);
        await pointer.click($('[data-bench-share]', boardDemo), benchRunner, g);
        await w(300);
        await pointer.click(tabs.find(tab => tab.dataset.benchTab === 'board'), benchRunner, g);
        setPane('board');
        await w(500);
        mine?.classList.remove('is-pending'); mine?.classList.add('is-arrive'); setSort('decode');
        await w(2600);
        mine?.classList.remove('is-arrive');
        await pointer.click(sortButtons[1], benchRunner, g); setSort('prefill');
        await w(2400);
        await pointer.click(sortButtons[0], benchRunner, g); setSort('decode');
        pointer.hide();
        await w(2400);
      },
      final() { pointer.hide(); showAll(); setPane('board'); setSort('decode'); },
      onInterrupt() { pointer.hide(); showAll(); setSort(sortButtons.find(button => button.classList.contains('is-on'))?.dataset.sort || 'decode'); },
    });
    sortButtons.forEach(button => button.addEventListener('click', event => { if (!event.isTrusted) return; benchRunner.interrupt(); setPane('board'); setSort(button.dataset.sort); }));
    tabs.forEach(tab => tab.addEventListener('click', event => { if (!event.isTrusted) return; benchRunner.interrupt(); setPane(tab.dataset.benchTab); }));
    showAll(); setSort('decode');
  }

  // Gallery tiles replay their small CSS animations once they scroll into view.
  if ('IntersectionObserver' in window) {
    const tileObserver = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('in-view'); tileObserver.unobserve(entry.target); }
    }), { threshold: 0.35 });
    $$('.tile').forEach(tile => tileObserver.observe(tile));
    const stage = $('.stage-canvas');
    if (stage) new IntersectionObserver(entries => { stageVisible = entries[0].isIntersecting; updateTelemetry(); }, { threshold: 0.15 }).observe(stage);
  } else {
    stageVisible = true; updateTelemetry();
    $$('.tile').forEach(tile => tile.classList.add('in-view'));
  }

  // ---------- Language ----------
  function setLanguage(nextLang) {
    currentLang = nextLang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = currentLang === 'en' ? 'en' : 'zh-CN';
    document.title = pageTitles[currentLang];
    translatable.forEach(item => { item.element.textContent = item[currentLang]; });
    if (activeReleaseTag) $$('.release-version').forEach(el => { el.textContent = activeReleaseTag; });
    renderReleaseStatus();
    attributeTranslations.forEach(item => {
      const value = item[currentLang];
      if (value !== null && value !== undefined) item.element.setAttribute(item.attribute, value);
    });
    const ogLocale = $('#og-locale');
    const ogLocaleAlt = $('#og-locale-alternate');
    if (ogLocale) ogLocale.content = currentLang === 'en' ? 'en_US' : 'zh_CN';
    if (ogLocaleAlt) ogLocaleAlt.content = currentLang === 'en' ? 'zh_CN' : 'en_US';
    if (languageLabel) languageLabel.textContent = currentLang === 'en' ? '中文' : 'EN';
    const switchAction = currentLang === 'en' ? 'Switch to 简体中文' : 'Switch to English';
    if (languageButton) { languageButton.setAttribute('aria-label', switchAction); languageButton.title = switchAction; }
    streamTargets.forEach(element => { delete element.dataset.full; });
    renderScreen(activeView);
    { const keep = sbState; setSvc(svc); setStatusbar(keep); }
    fitDemo?.refreshLanguage?.();
    updateDemoToggle();
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

  // ---------- Header, menu, theme ----------
  if (mobileMenuBtn && primaryNav) {
    mobileMenuBtn.addEventListener('click', () => {
      const open = primaryNav.classList.toggle('open');
      mobileMenuBtn.setAttribute('aria-expanded', String(open));
    });
    $$('a', primaryNav).forEach(link => link.addEventListener('click', () => {
      primaryNav.classList.remove('open');
      mobileMenuBtn.setAttribute('aria-expanded', 'false');
    }));
  }
  const header = $('#site-header');
  const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  themeButton?.addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true));
  // Light is the default; dark is only an explicit, remembered choice.

  // ---------- Releases: enable downloads only after validating published assets ----------
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
      const labels = { windows: 'Windows', appimage: 'AppImage', deb: 'DEB', dmg: 'DMG' };
      const missing = releaseState.missing.map(key => labels[key]).join(' / ');
      status.textContent = `${channel}${missing ? (english ? ` Unavailable assets: ${missing}. Those downloads are disabled.` : ` 缺少 ${missing} 资产，对应下载已禁用。`) : ''}`;
    }
  }

  function applyRelease(release, source = 'live') {
    const urls = strataReleaseCatalog.assets(release);
    activeReleaseTag = release?.tag_name || (currentLang === 'en' ? 'Unavailable' : '暂无可用发布');
    // The demo window shows the published version; the build already wrote package.json's version as a fallback.
    if (release?.tag_name) $$('[data-app-version]').forEach(el => { el.textContent = release.tag_name; });
    releaseState = release ? { kind: 'ready', preview: release.prerelease, snapshot: source === 'snapshot', missing: strataReleaseCatalog.keys.filter(key => !urls[key]) } : { kind: 'unavailable' };
    document.querySelectorAll('.release-version').forEach(el => { el.textContent = activeReleaseTag; });
    const elements = Object.fromEntries([...strataReleaseCatalog.keys, ...strataReleaseCatalog.optionalKeys].map(key => [key, document.querySelector(`[data-download="${key}"]`)]));
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
    // The verified snapshot covers first paint; refresh from GitHub only when it is missing
    // or the visitor approaches the download section, so most visits skip the API entirely.
    const snapshotRelease = await snapshotPromise;
    const section = $('#get-started');
    if (snapshotRelease && section && 'IntersectionObserver' in window) {
      await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); resolve(); }
        }, { rootMargin: '400px 0px' });
        observer.observe(section);
      });
    }
    try {
      const prefix = `https://api.github.com/repos/${strataReleaseCatalog.repo}/releases`;
      // The bounded list is only needed when /latest has no stable release to offer.
      const latest = await metadata(`${prefix}/latest`, true).catch(() => null);
      const list = latest?.status === 200 ? { status: 200, releases: [] } : await metadata(`${prefix}?per_page=100`, false).catch(() => null);
      const snapshot = snapshotRelease;
      const live = strataReleaseCatalog.selectResponses(latest, list);
      if (live) applyRelease(live);
      else if (!snapshot) applyRelease(null);
    } catch (_) {
      if (!await snapshotPromise) applyRelease(null);
    }
  }

  // ---------- Scroll motion: CSS reveals triggered by IntersectionObserver (no animation library) ----------
  function animatePage() {
    if (!motionAllowed()) return;
    document.documentElement.classList.add('motion');
    $$('.feature-card, .gallery-item, .download-card').forEach(element => element.classList.add('reveal', 'is-soft'));
    const reveals = $$('.reveal');
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
      }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      reveals.forEach(element => observer.observe(element));
    } else reveals.forEach(element => element.classList.add('is-visible'));
  }

  // Below-the-fold workspace demos: load their player only when the list approaches the viewport.
  function lazyDemoTiles() {
    const list = $('.ws-index');
    if (!list) return;
    const load = () => {
      if (document.querySelector('script[data-demo-tiles]')) return;
      // Styles and player arrive together; the tiles stay inert <template> markup until then.
      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = new URL('demo-tiles.css', siteRoot).href;
      document.head.append(style);
      const script = document.createElement('script');
      script.src = new URL('demo-tiles.js', siteRoot).href;
      script.defer = true;
      script.dataset.demoTiles = '';
      document.head.append(script);
    };
    if (!('IntersectionObserver' in window)) { load(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '600px 0px' });
    observer.observe(list);
  }

  // The intro video stays at preload="none"; its poster is fetched only when the section nears the viewport.
  function lazyIntroVideo() {
    const video = $('.intro-video');
    if (!video) return;
    const play = $('.intro-video-play');
    if (play) {
      // One large, obvious play target over the poster; native controls take over once playback starts.
      play.hidden = false;
      play.addEventListener('click', () => { video.play().catch(() => {}); });
      video.addEventListener('play', () => { play.hidden = true; });
    }
    const load = () => {
      const poster = currentLang === 'en' ? video.dataset.posterEn : video.dataset.poster;
      if (poster && !video.poster) video.poster = new URL(poster, siteRoot).href;
    };
    if (!('IntersectionObserver' in window)) { load(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: '400px 0px' });
    observer.observe(video);
  }

  setLanguage(pageLanguage);
  fitApp();
  runners.forEach(runner => runner.init());
  // Taskbar monitor recreation: example readings tick only while visible and motion is allowed.
  // Like the real widget, only one speed is live at a time (prefill, then generation); the other shows a dash.
  function taskbarDemo() {
    const root = document.querySelector('.tb-demo');
    if (!root) return;
    const lines = { gen: root.querySelector('.tb-gen'), prefill: root.querySelector('.tb-prefill') };
    const ring = root.querySelector('.tb-value'), label = root.querySelector('.tb-ring text');
    const show = (phase, value) => Object.entries(lines).forEach(([key, line]) => {
      const live = key === phase;
      line.classList.toggle('idle', !live);
      line.querySelector('b').textContent = live ? value : '—';
    });
    show('prefill', '3.2k');
    if (reduceMotion.matches) return;
    const frames = [['prefill', '3.2k', 82], ['prefill', '3.4k', 84], ['gen', '21.3', 76], ['gen', '22.1', 78], ['gen', '20.8', 74], ['gen', '21.7', 77]];
    let index = 0, timer = 0;
    const tick = () => {
      index = (index + 1) % frames.length;
      const [phase, value, r] = frames[index];
      show(phase, value);
      ring.setAttribute('stroke-dasharray', `${r} 100`); label.textContent = String(r);
    };
    const run = on => { clearInterval(timer); if (on) timer = setInterval(tick, 1400); };
    if ('IntersectionObserver' in window) new IntersectionObserver(entries => run(entries[0].isIntersecting), { threshold: 0.4 }).observe(root);
  }

  updateDemoToggle();
  animatePage();
  lazyDemoTiles();
  lazyIntroVideo();
  taskbarDemo();
  fetchLatestRelease();
})();
