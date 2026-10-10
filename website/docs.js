// Only appearance preferences belong to the browser; document content is static HTML.
(() => {
  'use strict';
  const key = 'strata-manager-site-theme';
  let theme = 'dark';
  try {
    const saved = localStorage.getItem(key);
    theme = saved === 'light' || saved === 'dark' ? saved : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch (_) {}

  const en = document.documentElement.lang === 'en';
  function apply(value, persist = false) {
    document.documentElement.dataset.theme = value;
    const meta = document.getElementById('theme-color');
    if (meta) meta.content = value === 'light' ? '#f5f9f6' : '#06130e';
    const button = document.getElementById('doc-theme');
    if (button) {
      const label = value === 'light' ? (en ? 'Switch to dark theme' : '切换到深色主题') : (en ? 'Switch to light theme' : '切换到浅色主题');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.textContent = value === 'light' ? (en ? 'Dark' : '深色') : (en ? 'Light' : '浅色');
    }
    if (persist) {
      try { localStorage.setItem(key, value); } catch (_) {}
    }
  }
  apply(theme);
  document.addEventListener('DOMContentLoaded', () => {
    apply(document.documentElement.dataset.theme);
    // Keep the article visible first on a narrow screen; navigation remains expandable.
    if (window.matchMedia('(max-width: 850px)').matches) {
      const navigation = document.querySelector('.doc-navigation');
      if (navigation) navigation.open = false;
    }
    document.getElementById('doc-theme')?.addEventListener('click', () => {
      apply(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
    });
  });
})();
