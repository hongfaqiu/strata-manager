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
