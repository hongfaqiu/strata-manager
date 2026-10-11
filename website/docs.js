// Only appearance preferences belong to the browser; document content is static HTML.
(() => {
  'use strict';
  const key = 'strata-manager-site-theme';
  const colorPreference = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = colorPreference.matches ? 'dark' : 'light';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch (_) {}

  const en = document.documentElement.lang === 'en';
  function apply(value, persist = false) {
    document.documentElement.dataset.theme = value;
    const meta = document.getElementById('theme-color');
    if (meta) meta.content = value === 'light' ? '#f5f4ef' : '#101c18';
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
    // The article comes first on a narrow screen; restore the sidebar when it widens.
    const navigation = document.querySelector('.doc-navigation');
    const narrowLayout = window.matchMedia('(max-width: 850px)');
    const updateNavigation = () => { if (navigation) navigation.open = !narrowLayout.matches; };
    updateNavigation();
    narrowLayout.addEventListener('change', updateNavigation);

    // Overflowing examples remain readable using the keyboard as well as touch.
    document.querySelectorAll('.markdown-body pre:not(.license-text)').forEach((example) => {
      example.tabIndex = 0;
      example.setAttribute('role', 'region');
      example.setAttribute('aria-label', en ? 'Code example' : '代码示例');
    });
    document.getElementById('doc-theme')?.addEventListener('click', () => {
      apply(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
    });
    colorPreference.addEventListener('change', () => {
      let saved;
      try { saved = localStorage.getItem(key); } catch (_) {}
      if (saved !== 'light' && saved !== 'dark') apply(colorPreference.matches ? 'dark' : 'light');
    });
  });
})();
