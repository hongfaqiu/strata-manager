/* Progressive enhancement: all essential content is readable without JavaScript. */
(() => {
  'use strict';

  const title = {
    zh: 'Strata Manager · 本地模型，一站管理',
    en: 'Strata Manager · Local models. One workspace.',
  };
  const screens = {
    overview: {
      index: '01',
      zh: {
        title: '打开应用，知道下一步做什么。',
        description: '当前模型、服务状态、资源和用量汇于总览，从这里进入聊天或管理模型。',
        alt: '总览：查看当前模型、后台服务、API 用量与资源概况；数值为演示数据',
      },
      en: {
        title: 'Open the app. Know what comes next.',
        description: 'Model readiness, service state, resources, and usage at a glance. Start a conversation or manage models from here.',
        alt: 'Overview: current model, background service, API usage, and resources; values are demonstration data',
      },
    },
    chat: {
      index: '02',
      zh: {
        title: '对话和资料，在同一处。',
        description: '会话历史、流式回答、思考过程与附件集中展示，让每次对话容易接续。',
        alt: '聊天：多会话历史、流式回答、思考与附件；聊天内容为演示数据',
      },
      en: {
        title: 'Conversations and context, together.',
        description: 'Conversation history, streamed replies, reasoning, and attachments keep the next exchange within easy reach.',
        alt: 'Chat: conversation history, streamed replies, reasoning, and attachments; content is demonstration data',
      },
    },
    models: {
      index: '03',
      zh: {
        title: '从已有模型，到准备新的。',
        description: '检测和导入已有安装，准备新模型，跟进任务进度；选中后交给后台启动与加载。',
        alt: '模型：本机安装、模型准备与任务进度；模型状态为演示数据',
      },
      en: {
        title: 'Keep what you have. Prepare what you need.',
        description: 'Detect and import installations, prepare a model, and follow task progress. The background handles startup and loading.',
        alt: 'Models: local installations, preparation, and task progress; model state is demonstration data',
      },
    },
    usage: {
      index: '04',
      zh: {
        title: '让日常使用，有据可查。',
        description: '请求趋势、tokens、成功率、等待时间和缓存复用，帮助理解本机 API 的使用情况。',
        alt: 'API 用量：请求趋势、tokens、成功率、等待时间与缓存；所有数值为演示数据',
      },
      en: {
        title: 'Understand your everyday API activity.',
        description: 'Follow request trends, tokens, success rate, waiting time, and cache reuse to understand how your local API is used.',
        alt: 'API usage: request trends, tokens, success rate, waiting time, and cache; all values are demonstration data',
      },
    },
    tuning: {
      index: '05',
      zh: {
        title: '看过比较，再选择改变。',
        description: '检查基线与候选结果的一致性和波动，再应用或恢复；稳定收益由实际测量决定。',
        alt: '参数调优：场景选择、基线和候选比较；结果为演示数据，不代表性能承诺',
      },
      en: {
        title: 'Compare first. Change with a reason.',
        description: 'Review baseline and candidate consistency and variation, then apply or restore. Stable benefits come from actual measurements.',
        alt: 'Tuning: scenarios, baseline, and candidate comparison; results are demonstration data, not performance claims',
      },
    },
  };

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
  ].flatMap(([dataAttribute, attribute]) => Array.from(document.querySelectorAll(`[${dataAttribute}]`)).map(element => ({
    element,
    attribute,
    zh: element.getAttribute(attribute),
    en: element.getAttribute(dataAttribute),
  })));

  const languageButton = document.getElementById('language-switch');
  const languageLabel = document.getElementById('language-label');
  const tabs = Array.from(document.querySelectorAll('[data-screen]'));
  const panel = document.getElementById('screen-panel');
  const screenImage = document.getElementById('screen-image');
  const screenLink = document.getElementById('screen-link');
  const screenTitle = document.getElementById('screen-title');
  const screenDescription = document.getElementById('screen-description');
  const screenIndex = document.getElementById('screen-index');
  let activeScreen = 'overview';
  let language = 'zh';

  function renderScreen(name) {
    if (!Object.prototype.hasOwnProperty.call(screens, name)) return;
    activeScreen = name;
    const screen = screens[name];
    const copy = screen[language];
    const imagePath = `assets/screenshots/${name}.zh.webp`;
    if (screenImage.getAttribute('src') !== imagePath) screenImage.src = imagePath;
    screenImage.alt = copy.alt;
    screenLink.href = imagePath;
    screenIndex.textContent = screen.index;
    screenTitle.textContent = copy.title;
    screenDescription.textContent = copy.description;
    panel.setAttribute('aria-labelledby', `tab-${name}`);
    tabs.forEach(tab => {
      const selected = tab.dataset.screen === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
  }

  function setLanguage(nextLanguage, persist = false) {
    language = nextLanguage === 'en' ? 'en' : 'zh';
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = title[language];
    translatable.forEach(item => { item.element.textContent = item[language]; });
    attributeTranslations.forEach(item => { item.element.setAttribute(item.attribute, item[language]); });
    document.getElementById('og-locale').content = language === 'en' ? 'en_US' : 'zh_CN';
    document.getElementById('og-locale-alternate').content = language === 'en' ? 'zh_CN' : 'en_US';
    languageLabel.textContent = language === 'en' ? '中文' : 'EN';
    const action = language === 'en' ? 'Switch to 简体中文' : '切换到 English';
    languageButton.setAttribute('aria-label', action);
    languageButton.title = action;
    renderScreen(activeScreen);
    if (persist) {
      try { localStorage.setItem('strata-manager-site-language', language); } catch { /* Private browsing can disable storage. */ }
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('lang', language);
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      } catch { /* Translation also works when history is unavailable. */ }
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => renderScreen(tab.dataset.screen));
    tab.addEventListener('keydown', event => {
      let target = index;
      if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[target].focus();
      renderScreen(tabs[target].dataset.screen);
    });
  });
  languageButton.addEventListener('click', () => setLanguage(language === 'zh' ? 'en' : 'zh', true));

  let initialLanguage = 'zh';
  try {
    const requested = new URLSearchParams(window.location.search).get('lang');
    if (requested === 'en' || requested === 'zh') initialLanguage = requested;
    else {
      const remembered = localStorage.getItem('strata-manager-site-language');
      if (remembered === 'en' || remembered === 'zh') initialLanguage = remembered;
    }
  } catch { /* Default Chinese stays available without browser storage. */ }
  panel.setAttribute('role', 'tabpanel');
  document.querySelector('.screenshot-tabs').hidden = false;
  languageButton.hidden = false;
  setLanguage(initialLanguage);
})();
