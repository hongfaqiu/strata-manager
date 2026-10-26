import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = file => readFileSync(new URL(file, import.meta.url), 'utf8');

// Regression: on 桌面监控 the sr-only announcements and preview grips of the
// strip settings were position:absolute with no positioned ancestor, so they
// hung off the viewport and made the document itself scrollable. A
// scrollIntoView() (tray / strip menu "设置", "任务栏颜色") then scrolled the
// whole window and pushed the title bar and sub-nav out of view.
test('only .main-content scrolls: the app frame clips stray absolute boxes', () => {
  const frame = css('./window-title-bar.css').match(/\.desktop-app-frame\{[^}]*\}/)?.[0] ?? '';
  assert.match(frame, /position:relative/);
  assert.match(frame, /overflow:hidden/);
  assert.match(frame, /height:100dvh/);
  assert.match(css('./styles.css'), /\.main-content\{[^}]*overflow:auto/);
});

test('strip settings panel is the containing block for its absolute children', () => {
  const settings = css('./pages/floating-monitor-settings.css');
  assert.match(settings, /\.floating-monitor-settings\{position:relative\}/);
  assert.match(settings, /\.floating-monitor-settings-announcement\{[^}]*position:absolute/);
});
