// Plays the HTML screen recreations (.dd) built by scripts/website-demo-tiles.mjs.
// data-seq="k" turns on at step k, data-cycle rotates its highlighted child, data-jit wobbles a number,
// data-type types its text when its step arrives. Only visible tiles run; reduced motion shows the final state.
(() => {
  'use strict';
  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const tiles = new Map();
  const TICK = 900;
  const setup = tile => {
    if (tiles.has(tile)) return;
    const steps = Number(tile.dataset.steps) || 1;
    const seqs = Array.from(tile.querySelectorAll('[data-seq]'));
    const cycles = Array.from(tile.querySelectorAll('[data-cycle]'));
    const jits = Array.from(tile.querySelectorAll('[data-jit]'));
    const types = Array.from(tile.querySelectorAll('[data-type]'));
    types.forEach(el => { el.dataset.full = el.textContent; });
    const state = { tile, steps, seqs, cycles, jits, types, step: steps, visible: false, tick: 0 };
    tiles.set(tile, state);
    paint(state, true);
  };
  const typeIn = el => {
    const full = el.dataset.full || '';
    const owner = el.closest('[data-seq]');
    if (!full || el.dataset.typing) return;
    el.dataset.typing = '1';
    let i = 0;
    const chunk = Math.max(1, Math.round(full.length / 28));
    el.textContent = '';
    const timer = setInterval(() => {
      i += chunk;
      el.textContent = full.slice(0, i);
      if (i >= full.length || !owner?.classList.contains('is-on')) { clearInterval(timer); el.textContent = full; delete el.dataset.typing; }
    }, 28);
  };
  function paint(state, final) {
    const { step, seqs, types } = state;
    seqs.forEach(el => {
      const on = final || Number(el.dataset.seq) <= step;
      if (on && !el.classList.contains('is-on') && !final) el.querySelectorAll?.('[data-type]').forEach(typeIn);
      if (on && !final && el.hasAttribute('data-type') && !el.classList.contains('is-on')) typeIn(el);
      el.classList.toggle('is-on', on);
    });
    if (final) types.forEach(el => { el.textContent = el.dataset.full; });
  }
  function advance(state) {
    state.tick += 1;
    // Each loop: reset, reveal steps one by one, hold the final state for three ticks.
    state.step = state.step >= state.steps + 3 ? 0 : state.step + 1;
    paint(state, false);
    if (state.tick % 3 === 0) state.cycles.forEach(group => {
      const items = Array.from(group.children);
      const index = items.findIndex(item => item.classList.contains('is-on'));
      items.forEach((item, i) => item.classList.toggle('is-on', i === (index + 1) % items.length));
    });
    state.jits.forEach(el => {
      const base = Number(el.dataset.jit), range = Number(el.dataset.range) || 0, digits = Number(el.dataset.digits) || 0;
      const value = base + (Math.random() - 0.5) * range;
      el.textContent = value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    });
  }
  let timer = null;
  const running = () => !reduce.matches && !document.hidden;
  function update() {
    const any = running() && Array.from(tiles.values()).some(state => state.visible);
    if (any && !timer) timer = setInterval(() => tiles.forEach(state => { if (state.visible) advance(state); }), TICK);
    if (!any && timer) { clearInterval(timer); timer = null; }
    if (!running()) tiles.forEach(state => { state.step = state.steps; paint(state, true); state.tile.classList.remove('is-playing'); if (reduce.matches) state.tile.classList.remove('is-anim'); });
  }
  function translate(root) {
    // Homepage tiles carry data-en like the rest of the page; follow the page language.
    if ((document.documentElement.lang || '').toLowerCase().startsWith('en')) {
      root.querySelectorAll('[data-en]').forEach(el => { el.textContent = el.dataset.en; });
      root.querySelectorAll('[data-label-en]').forEach(el => el.setAttribute('aria-label', el.dataset.labelEn));
    }
  }
  function init() {
    // Build lazily templated tiles (homepage) before wiring them up.
    document.querySelectorAll('.dd-slot > template').forEach(template => {
      const fragment = template.content.cloneNode(true);
      translate(fragment);
      template.replaceWith(fragment);
    });
    const all = Array.from(document.querySelectorAll('.dd[data-demo-tile]'));
    all.forEach(setup);
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const state = tiles.get(entry.target);
        if (!state) return;
        if (entry.isIntersecting && !state.visible && running()) { entry.target.classList.add('is-anim'); state.step = 0; paint(state, false); }
        state.visible = entry.isIntersecting;
        entry.target.classList.toggle('is-playing', entry.isIntersecting && running());
      });
      update();
    }, { threshold: 0.35 });
    all.forEach(tile => observer.observe(tile));
    document.addEventListener('visibilitychange', update);
    reduce.addEventListener?.('change', update);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
