/* Strata Manager · Modern Interactive Application Engine */
// Release catalog contract is independent of DOM and network state.
const strataReleaseCatalog = (() => {
  const repo = 'hongfaqiu/strata-manager';
  const base = `https://github.com/${repo}/releases`;
  const keys = ['windows', 'appimage', 'deb', 'checksums'];
  // DMG is optional: a published Windows/Linux release stays complete without it.
  const optionalKeys = ['dmg'];

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
      dmg: `Strata.Manager_${clean}_aarch64.dmg`,
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
      "zh": { "title": "独立浮条 · 紧凑监控", "description": "纯指标浮条支持任意位置拖动，操作集中在原生右键菜单与系统托盘。", "alt": "紧凑桌面监控浮条：服务状态与生成、输入处理指标", "badge": "桌面监控浮条" },
      "en": { "title": "Floating monitor · Compact metrics", "description": "Drag the metrics-only strip anywhere and use its native context menu or system tray for actions.", "alt": "Compact floating monitor: service status, generation and input-processing metrics", "badge": "FLOATING MONITOR" }
    },
    "floating-monitor-settings": {
      "index": "14", "image": "floating-monitor-settings",
      "zh": { "title": "浮条设置 · 显示与托盘", "description": "设置默认置顶、采样时间与系统托盘监控。", "alt": "监控浮动条设置：置顶、采样时间和系统托盘监控", "badge": "浮条设置" },
      "en": { "title": "Monitor settings · Display and tray", "description": "Set the default pin state, sample-time display and system tray monitoring.", "alt": "Floating monitor settings: pin state, sample time and system tray monitoring", "badge": "MONITOR SETTINGS" }
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

  // Stage tabs map to rebuilt app views; each view links to its real screenshot.
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
      cherry: 'Provider   OpenAI 兼容\nAPI 地址   http://127.0.0.1:19001/v1\nAPI 密钥   strata-local\n模型       Swift-Qwen3.8-Flash-Next',
    },
    en: {
      verdict: { fits: 'Runs on this computer with about {free} GB of VRAM to spare.', tight: 'Runs, but only about {free} GB of VRAM is left; long contexts will be slower.', over: 'Exceeds this computer\u2019s VRAM and memory. Pick a smaller quantization.' },
      checking: 'Checking…', upToDate: 'Up to date · SHA256 verified', copied: 'Copied',
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
  const screenLink = $('#screen-link');
  const screenTitle = $('#screen-title');
  const screenDescription = $('#screen-description');
  const screenIndex = $('#screen-index');
  const screenPanel = $('#screen-panel');

  const lightboxModal = $('#lightbox-modal');
  const lightboxImg = $('#lightbox-img');
  const lightboxBadge = $('#lightbox-badge');
  const lightboxTitle = $('#lightbox-title');
  const lightboxCloseBtn = $('#lightbox-close-btn');
  const lightboxBackdrop = $('#lightbox-backdrop');
  const lightboxDialog = lightboxModal?.querySelector('.lightbox-dialog');
  const lightboxBar = lightboxModal?.querySelector('.lightbox-bar');
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

  function renderScreen(key, { animate = false } = {}) {
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
    if (screenLink) {
      screenLink.href = new URL(`assets/screenshots/${item.image || view.screen}.${currentLang}.webp`, siteRoot).href;
      screenLink.dataset.target = view.screen;
    }
    screenPanel?.setAttribute('aria-labelledby', `tab-${key}`);
    wsTabs.forEach(tab => {
      const selected = tab.dataset.screen === key;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    onViewShown(key);
  }

  wsTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => renderScreen(tab.dataset.screen, { animate: true }));
    tab.addEventListener('keydown', event => {
      const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: wsTabs.length - 1 };
      if (!(event.key in moves)) return;
      event.preventDefault();
      const target = wsTabs[(moves[event.key] + wsTabs.length) % wsTabs.length];
      target.focus();
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

  // ---------- Live telemetry (pauses off-screen, off for reduced motion) ----------
  const live = name => $$(`[data-live="${name}"]`);
  const setLive = (name, value) => live(name).forEach(element => {
    const first = element.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) first.nodeValue = value;
    else element.insertBefore(document.createTextNode(value), first);
  });
  const spark = Array.from({ length: 24 }, (_, i) => 33 - i * 0.12 + Math.sin(i * 0.9) * 0.6);
  let tps = 32, load = 40, power = 210, genTokens = 140, clock = 14 * 3600 + 34 * 60 + 31, requestTotal = 128, tick = 0;
  const overviewSpark = $('.app-view[data-view="overview"] .m-spark');
  function drawSpark() {
    if (!overviewSpark) return;
    const min = 26, max = 38;
    const points = spark.map((value, i) => `${(i / (spark.length - 1) * 300).toFixed(1)} ${(60 - (value - min) / (max - min) * 56).toFixed(1)}`);
    overviewSpark.querySelector('.line').setAttribute('d', `M${points.join(' L')}`);
    overviewSpark.querySelector('.area').setAttribute('d', `M${points.join(' L')} L300 60 L0 60 Z`);
  }
  const requests = $('[data-requests]');
  const time = seconds => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  function pushRequest() {
    if (!requests) return;
    clock += 20;
    requestTotal += 1;
    const row = document.createElement('li');
    row.className = 'is-new';
    row.innerHTML = `<i></i><span>${time(clock)}</span><span>4,096 → 384</span><span>${tps.toFixed(1)} <small>tok/s</small></span>`;
    requests.prepend(row);
    while (requests.children.length > 6) requests.lastElementChild.remove();
    setLive('reqs', String(requestTotal));
  }
  function telemetryTick() {
    tick += 1;
    tps = Math.min(34.2, Math.max(29.6, tps + (Math.random() - 0.5) * 1.1));
    load = Math.round(Math.min(47, Math.max(34, load + (Math.random() - 0.5) * 5)));
    power = Math.round(Math.min(224, Math.max(196, power + (Math.random() - 0.5) * 9)));
    genTokens = genTokens >= 512 ? 0 : genTokens + Math.round(tps * 1.2);
    setLive('tps', String(Math.round(tps)));
    ['tps1', 'tps2'].forEach(name => setLive(name, tps.toFixed(1)));
    setLive('chat-tps', `${tps.toFixed(1)} tok/s`);
    setLive('load', String(load)); setLive('load2', String(load));
    setLive('power', String(power)); setLive('power2', String(power));
    setLive('gen-tokens', `${Math.min(genTokens, 512)} tokens · ${tps.toFixed(1)} tok/s`);
    live('gen-bar').forEach(bar => { bar.style.width = `${Math.min(100, genTokens / 5.12)}%`; });
    spark.push(tps); spark.shift(); drawSpark();
    if (tick % 3 === 0) pushRequest();
  }
  let telemetryTimer = null;
  let stageVisible = false;
  function updateTelemetry() {
    const run = stageVisible && motionAllowed() && !document.hidden;
    if (run && !telemetryTimer) telemetryTimer = setInterval(telemetryTick, 1100);
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

  // ---------- Chat: stream the answer ----------
  const answer = $('[data-stream]');
  const streamTargets = answer ? $$('li, code, p', answer) : [];
  let streamRun = 0;
  let streamed = false;
  async function streamAnswer() {
    if (!answer || !motionAllowed()) return;
    const run = ++streamRun;
    const texts = streamTargets.map(element => element.dataset.full ?? (element.dataset.full = element.textContent));
    streamTargets.forEach(element => { element.textContent = ''; element.setAttribute('data-pending', ''); element.classList.remove('is-typing'); });
    const pre = answer.querySelector('pre');
    pre?.setAttribute('data-pending', '');
    await wait(420);
    for (let index = 0; index < streamTargets.length; index += 1) {
      const element = streamTargets[index];
      if (run !== streamRun) return;
      if (element.tagName === 'CODE') pre?.removeAttribute('data-pending');
      element.removeAttribute('data-pending');
      element.classList.add('is-typing');
      const chars = Array.from(texts[index]);
      const step = currentLang === 'en' ? 3 : 2;
      for (let i = 0; i < chars.length; i += step) {
        if (run !== streamRun) return;
        element.textContent = chars.slice(0, i + step).join('');
        await wait(element.tagName === 'CODE' ? 12 : 26);
      }
      element.classList.remove('is-typing');
      await wait(140);
    }
    streamed = true;
  }
  function stopStream() {
    if (!answer) return;
    streamRun += 1;
    streamTargets.forEach(element => { if (element.dataset.full !== undefined) element.textContent = element.dataset.full; element.removeAttribute('data-pending'); element.classList.remove('is-typing'); });
    answer.querySelector('pre')?.removeAttribute('data-pending');
  }
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  function onViewShown(key) {
    if (key === 'usage' && bars && motionAllowed()) { bars.classList.remove('is-grow'); void bars.offsetWidth; bars.classList.add('is-grow'); }
    if (key === 'chat') { if (stageVisible) streamAnswer(); }
    else stopStream();
  }

  // ---------- Feature demos ----------
  const fitDemo = $('[data-fit-demo]');
  if (fitDemo) {
    const options = $$('.fit-opt', fitDemo);
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
    };
    options.forEach((option, index) => {
      option.tabIndex = option.classList.contains('is-on') ? 0 : -1;
      option.addEventListener('click', () => select(option));
      option.addEventListener('keydown', event => {
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!delta) return;
        event.preventDefault();
        const next = options[(index + delta + options.length) % options.length];
        next.focus(); select(next);
      });
    });
  }

  const connectDemo = $('[data-connect-demo]');
  const steps = connectDemo ? $$('[data-steps] li', connectDemo) : [];
  let stepsRun = 0;
  async function runSteps() {
    const run = ++stepsRun;
    steps.forEach(step => { step.classList.remove('is-ok', 'is-run'); step.querySelector('em').textContent = ''; });
    for (const step of steps) {
      if (run !== stepsRun) return;
      step.classList.add('is-run');
      await wait(motionAllowed() ? 520 : 0);
      if (run !== stepsRun) return;
      step.classList.replace('is-run', 'is-ok');
      step.querySelector('em').textContent = step.dataset.stepTime;
    }
  }
  if (connectDemo) {
    const config = $('[data-client-config]', connectDemo);
    const clientTabs = $$('[data-client]', connectDemo);
    clientTabs.forEach(tab => tab.addEventListener('click', () => {
      clientTabs.forEach(other => { const on = other === tab; other.classList.toggle('is-on', on); other.setAttribute('aria-selected', String(on)); });
      config.textContent = clientConfigs[tab.dataset.client]();
      runSteps();
    }));
    $('[data-steps-run]', connectDemo)?.addEventListener('click', runSteps);
    if (!motionAllowed()) runSteps();
  }

  const boardDemo = $('[data-board-demo]');
  function sortBoard(metric) {
    if (!boardDemo) return;
    const list = $('[data-board]', boardDemo);
    const rows = $$('li', list);
    const max = Math.max(...rows.map(row => Number(row.dataset[metric])));
    const before = new Map(rows.map(row => [row, row.getBoundingClientRect().top]));
    rows.sort((a, b) => Number(b.dataset[metric]) - Number(a.dataset[metric])).forEach((row, index) => {
      list.append(row);
      row.firstElementChild.textContent = String(index + 1);
      row.querySelector('[data-val]').textContent = metric === 'decode' ? Number(row.dataset.decode).toFixed(1) : Number(row.dataset.prefill).toLocaleString('en-US');
      row.querySelector('i b').style.width = `${(Number(row.dataset[metric]) / max) * 100}%`;
    });
    if (!motionAllowed()) return;
    rows.forEach(row => {
      const delta = before.get(row) - row.getBoundingClientRect().top;
      if (!delta) return;
      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => { row.style.transition = ''; row.style.transform = ''; });
    });
  }
  $$('[data-sort]', boardDemo || document).forEach(button => button.addEventListener('click', () => {
    $$('[data-sort]', boardDemo).forEach(other => { const on = other === button; other.classList.toggle('is-on', on); other.setAttribute('aria-pressed', String(on)); });
    sortBoard(button.dataset.sort);
  }));

  // Start demos when they scroll into view.
  if ('IntersectionObserver' in window) {
    const stage = $('.stage-canvas');
    if (stage) new IntersectionObserver(entries => {
      stageVisible = entries[0].isIntersecting;
      updateTelemetry();
      if (stageVisible && activeView === 'chat' && !streamed) streamAnswer();
    }, { threshold: 0.15 }).observe(stage);
    const once = (element, callback) => element && new IntersectionObserver((entries, observer) => {
      if (entries[0].isIntersecting) { observer.disconnect(); callback(); }
    }, { threshold: 0.35 }).observe(element);
    once(connectDemo, () => { if (motionAllowed()) runSteps(); });
    once(boardDemo, () => sortBoard('decode'));
  } else {
    stageVisible = true; updateTelemetry(); sortBoard('decode');
  }
  if (boardDemo && !motionAllowed()) sortBoard('decode');

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

  // ---------- Lightbox for real screenshots ----------
  let lightboxOpener = null;
  const backgroundSections = [$('.site-header'), $('main'), $('.site-footer')];
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
    const observer = new ResizeObserver(fitLightboxImage);
    observer.observe(lightboxModal); observer.observe(lightboxBar);
  }
  window.addEventListener('resize', fitLightboxImage);

  function openLightbox(screenKey) {
    if (!lightboxModal) return;
    const key = screens[screenKey] ? screenKey : 'overview';
    const item = screens[key];
    const text = item[currentLang];
    lightboxImg.src = new URL(`assets/screenshots/${item.image || key}.${currentLang}.webp`, siteRoot).href;
    lightboxImg.alt = text.alt;
    lightboxImg.width = item.width || 2880;
    lightboxImg.height = text.height || item.height || 1920;
    lightboxBadge.textContent = `${item.index} / ${text.badge}`;
    lightboxTitle.textContent = text.title;
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
  $$('.open-lightbox-btn').forEach(button => button.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openLightbox(button.dataset.target || stageViews[activeView].screen);
  }));
  lightboxCloseBtn?.addEventListener('click', closeLightbox);
  lightboxBackdrop?.addEventListener('click', closeLightbox);
  window.addEventListener('keydown', event => {
    if (!lightboxModal?.classList.contains('active')) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'Tab') { event.preventDefault(); lightboxCloseBtn?.focus(); }
  });

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
      const labels = { windows: 'Windows', appimage: 'AppImage', deb: 'DEB', checksums: 'SHA256SUMS', dmg: 'DMG' };
      const missing = releaseState.missing.map(key => labels[key]).join(' / ');
      status.textContent = `${channel}${missing ? (english ? ` Unavailable assets: ${missing}. Those downloads are disabled.` : ` 缺少 ${missing} 资产，对应下载已禁用。`) : ''}`;
    }
  }

  function applyRelease(release, source = 'live') {
    const urls = strataReleaseCatalog.assets(release);
    activeReleaseTag = release?.tag_name || (currentLang === 'en' ? 'Unavailable' : '暂无可用发布');
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

  // ---------- Scroll motion: GSAP + ScrollTrigger when available, CSS reveal otherwise ----------
  function animatePage() {
    if (!motionAllowed()) return;
    document.documentElement.classList.add('motion');
    const reveals = $$('.reveal');
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
      }), { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      reveals.forEach(element => observer.observe(element));
    } else reveals.forEach(element => element.classList.add('is-visible'));
    if (!window.gsap || !window.ScrollTrigger) return;
    const { gsap, ScrollTrigger } = window;
    gsap.registerPlugin(ScrollTrigger);
    // No pinning or scroll hijacking: a soft entrance and a slight lift of the stage while it scrolls in.
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('.hero-title-block > *', { y: 16, opacity: 0, duration: .7, stagger: .07, ease: 'power3.out' });
      gsap.from('.stage', { y: 40, opacity: 0, duration: 1, delay: .25, ease: 'power3.out' });
      gsap.fromTo('.stage-canvas', { '--lift': 0 }, { '--lift': 1, ease: 'none', scrollTrigger: { trigger: '.stage-canvas', start: 'top bottom', end: 'top 80px', scrub: true } });
      gsap.utils.toArray('.feature-card, .gallery-item, .download-card').forEach(item => gsap.from(item, { y: 14, opacity: 0, duration: .5, ease: 'power2.out', scrollTrigger: { trigger: item, start: 'top 94%', once: true } }));
    });
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  }

  setLanguage(pageLanguage);
  fitApp();
  animatePage();
  fetchLatestRelease();
})();
