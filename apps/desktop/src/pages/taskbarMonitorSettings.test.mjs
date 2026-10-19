import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('./TaskbarMonitorSettings.tsx', import.meta.url), 'utf8');
const native = readFileSync(new URL('../../src-tauri/src/taskbar_widget.rs', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

const items = ['generation', 'prefill', 'gpu', 'vram', 'temperature', 'status'];

test('settings page and native right-click menu use the same item wording', () => {
  const menu = native.slice(native.indexOf('fn item_menu_label'), native.indexOf('fn template'));
  for (const [language, english] of [['zh-CN', 'false'], ['en', 'true']]) {
    const copy = page.match(new RegExp(`'?${language}'?: \\{ generation: [^\\n]+`))?.[0];
    assert.ok(copy, language);
    for (const item of items) {
      const label = copy.match(new RegExp(`${item}: '([^']+)'`))?.[1];
      assert.ok(label, `${language} ${item}`);
      if (item === 'status' && english === 'true') assert.ok(menu.includes(`_ => "${label}"`));
      else assert.ok(menu.includes(`("${item}", ${english}) => "${label}"`), `${language} ${item} ${label}`);
    }
  }
});

test('taskbar monitor is a prominent Windows toggle that is off unless active', () => {
  assert.match(page, /'任务栏监控（Windows）'/);
  assert.match(page, /'Taskbar monitor \(Windows\)'/);
  assert.match(page, /checked=\{active\}/);
  assert.match(page, /默认关闭/);
  // Rendered above the desktop strip settings on the monitor page.
  assert.ok(app.indexOf('<TaskbarMonitorSettings') < app.indexOf('<FloatingMonitorSettings preferences='));
});

test('native menu changes are accepted back into settings', () => {
  assert.match(app, /typeof patch\.taskbarEnabled === 'boolean'/);
  assert.match(app, /allowed\.taskbar = core\.normalizeTaskbarWidgetPreferences\(patch\.taskbar\)/);
  assert.match(app, /setMonitorVisibility\(enabled, 'taskbar'/);
});

test('custom colours: settings rows, native fallback palette and menu entry stay in sync', () => {
  const core = readFileSync(new URL('../../../../packages/core/src/floating-monitor.ts', import.meta.url), 'utf8');
  // Default swatches mirror the native Palette::metric values.
  const palette = core.slice(core.indexOf('TASKBAR_WIDGET_PALETTE'), core.indexOf('TASKBAR_BACKGROUNDS'));
  for (const hex of palette.match(/#[0-9a-f]{6}/g)) assert.ok(native.includes(`rgb(0x${hex.slice(1)})`), hex);
  assert.match(native, /COLOR_ITEMS: \[&str; 5\] = \["generation", "prefill", "gpu", "vram", "temperature"\]/);
  assert.match(core, /TASKBAR_WIDGET_COLOR_ITEMS[^=]*= \['generation', 'prefill', 'gpu', 'vram', 'temperature'\]/);
  assert.match(native, /t\("自定义颜色…", "Customize colors…"\)/);
  assert.match(page, /id="settings-taskbar-colors"/);
  assert.match(page, /'恢复默认'/);
  assert.match(page, /type="color"/);
  assert.match(app, /destination === 'taskbarColors' \? 'settings-taskbar-colors'/);
});
