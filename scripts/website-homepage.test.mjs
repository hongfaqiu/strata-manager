import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderHomepage } from './website-seo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(join(root, path), 'utf8');

test('Homepage keeps the v0.1.7 layout, links every current screenshot and rebuilds visuals in HTML', async () => {
  const html = await read('website/index.html');
  assert.match(html, /class="hero-section"/);
  assert.match(html, /id="strata-diagram"/);
  assert.match(html, /class="feature-grid"/);
  assert.match(html, /id="daily-experience"/);
  assert.match(html, /class="workspace-tab-nav"/);
  // Product views are rebuilt in HTML; every stage tab has a matching app view.
  assert.match(html, /id="app-window"/);
  for (const view of ['overview', 'models', 'monitor', 'usage', 'chat', 'runtime']) {
    assert.match(html, new RegExp(`data-screen="${view}"`));
    assert.match(html, new RegExp(`class="app-view[^"]*" data-view="${view}"`));
  }
  assert.match(html, /class="gallery-grid[^"]*"/);
  assert.match(html, /id="get-started"/);
  // The hero plays a scripted session with a visible pause control and a fake pointer.
  assert.match(html, /id="demo-toggle"/);
  assert.match(html, /class="demo-pointer[^"]*" data-pointer/);
  for (const state of ['stopped', 'loading', 'live']) assert.match(html, new RegExp(`data-show="${state}"`));
  // Each feature row carries its own live HTML demo instead of a static image.
  for (const demo of ['fit', 'connect', 'boost', 'monitor', 'bench']) assert.match(html, new RegExp(`data-demo="${demo}"`));
  // Screenshots stay one click away (lightbox links) but are no longer loaded eagerly as images.
  assert.doesNotMatch(html, /<img[^>]+assets\/screenshots\//);
  assert.ok((html.match(/class="shot-link open-lightbox-btn"/g) || []).length >= 25, 'every recreated view links its real screenshot');
  for (const id of ['main', 'get-started', 'download-status', 'release-notes-link', 'language-switch', 'language-label']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ['windows', 'appimage', 'deb', 'checksums', 'dmg']) assert.match(html, new RegExp(`data-download="${key}"`));
  // Current product screenshots (top-level + daily-experience) stay reachable, not only old changelog pins
  for (const shot of [
    'product-cover', 'models', 'monitor', 'usage', 'chat', 'tuning', 'config', 'settings',
    'benchmark', 'scenario-benchmark', 'benchmark-report', 'runtime-download-settings',
    'connections', 'common-chat-settings', 'app-updates', 'service-status', 'running-services',
    'floating-monitor', 'floating-monitor-settings', 'language-settings',
    'daily-experience/model-download-list', 'daily-experience/model-download-detail',
    'daily-experience/startup-diagnostic', 'daily-experience/api-verification',
    'daily-experience/history-comparison', 'daily-experience/service-capabilities',
    'daily-experience/chat-execution', 'daily-experience/api-usage',
  ]) {
    assert.match(html, new RegExp(shot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(html, /Cursor|Codex/);
  assert.doesNotMatch(html, /官方脚本更新 Strata|Update Strata with the official script|官方更新脚本|official update script/);
  assert.match(html, /product-cover\.zh\.webp/);
  assert.match(html, /github\.com\/hongfaqiu\/strata-manager/);
  assert.match(html, /vendor\/gsap\.min\.js/);
  assert.doesNotMatch(html, /loading="lazy"/);
  assert.doesNotMatch(html, /发布候选|候选版|稳定版|未发行|Unreleased|Release candidate|Current stable/i);
  assert.doesNotMatch(html, /赋能|一站式|轻松|无缝/);
});

test('English homepage translations stay plain text so the static renderer can escape them', async () => {
  const html = await read('website/index.html');
  for (const match of html.matchAll(/data-en="([^"]*)"/g)) {
    assert.doesNotMatch(match[1], /<|&lt;/, `markup inside data-en: ${match[1]}`);
  }
  const english = renderHomepage(html, 'en');
  assert.match(english, /<html lang="en">/);
  assert.match(english, /Open-source desktop management/);
  assert.match(english, /href="\.\.\/assets\/screenshots\/product-cover\.en\.webp"/);
  const visible = english.replace(/data-zh="[^"]*"/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(visible, /开源桌面管理工具|下载 Strata Manager/);
});

test('Homepage script keeps release validation, lightbox catalog and optional motion', async () => {
  const js = await read('website/app.js');
  assert.match(js, /applyDownloads\(elements, urls\)/);
  assert.match(js, /release-catalog\.json/);
  assert.match(js, /Latest published release|最新已发布版本/);
  assert.match(js, /gsap|ScrollTrigger/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  // Autoplay demos only advance while visible and fall back to their final state.
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /if \(!motionAllowed\(\)\) final\?\.\(\)/);
  assert.match(js, /document\.hidden/);
  assert.doesNotMatch(js, /未发行|Unreleased|稳定版|UNRELEASED/);
});
