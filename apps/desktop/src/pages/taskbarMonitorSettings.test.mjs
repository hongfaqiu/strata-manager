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
  assert.match(native, /COLOR_ITEMS: \[&str; 6\] = \[\s*"generation",\s*"prefill",\s*"gpu",\s*"vram",\s*"temperature",\s*"context",?\s*\]/);
  assert.match(core, /TASKBAR_WIDGET_COLOR_ITEMS[^=]*= \['generation', 'prefill', 'gpu', 'vram', 'temperature', 'context'\]/);
  assert.match(native, /t\("自定义颜色…", "Customize colors…"\)/);
  assert.match(page, /id="settings-taskbar-colors"/);
  assert.match(page, /'恢复默认'/);
  assert.match(page, /type="color"/);
  assert.match(app, /destination === 'taskbarColors' \? 'settings-taskbar-colors'/);
});

test('context ring is offered in settings, menu and core with the same order', () => {
  const core = readFileSync(new URL('../../../../packages/core/src/floating-monitor.ts', import.meta.url), 'utf8');
  assert.match(native, /RINGS: \[&str; 4\] = \["gpu", "vram", "context", "off"\]/);
  assert.match(core, /TASKBAR_WIDGET_RINGS[^=]*= \['gpu', 'vram', 'context', 'off'\]/);
  assert.match(native, /"context" => t\("上下文占用", "Context usage"\)/);
  assert.match(page, /\{ value: 'context', label: zh \? '上下文' : 'Context' \}/);
  assert.match(page, /context: '上下文占用'/);
  assert.match(page, /context: 'Context usage'/);
});

test('settings preview stacks both speeds with the native glyph outlines', () => {
  assert.match(page, /stacked = !single && widget\.items\.includes\('generation'\) && widget\.items\.includes\('prefill'\)/);
  const outline = name => {
    const body = native.slice(native.indexOf(`Glyph::${name} => &[`), native.indexOf(']', native.indexOf(`Glyph::${name} => &[`)));
    return [...body.matchAll(/\((-?[\d.]+), (-?[\d.]+)\)/g)].map(m => `${Number(m[1])},${Number(m[2])}`).join(' ');
  };
  assert.ok(page.includes(`generation: '${outline('Spark')}'`), outline('Spark'));
  assert.ok(page.includes(`prefill: '${outline('Arrow')}'`), outline('Arrow'));
});

test('text rows setting offers auto, one and two rows and the one-row preview drops captions', () => {
  assert.match(page, /single = widget\.rows === 'single'/);
  for (const label of ['文字行数', '自动', '单行', '两行']) assert.ok(page.includes(`'${label}'`), label);
  assert.match(native, /ROWS: \[&str; 3\] = \["auto", "single", "double"\]/);
});

test('right-click menu is a crisp native Win32 popup owned by a foreground-capable window', () => {
  const host = readFileSync(new URL('../../src-tauri/src/taskbar_host.rs', import.meta.url), 'utf8');
  const owner = host.slice(host.indexOf('unsafe fn create_menu_owner'), host.indexOf('unsafe fn menu('));
  assert.match(owner, /ThreadDpiContext::per_monitor_v2\(\)/);
  assert.doesNotMatch(owner, /WS_EX_NOACTIVATE/);
  const track = host.slice(host.indexOf('unsafe fn menu('), host.indexOf('struct Attachment'));
  assert.match(track, /ThreadDpiContext::for_window\(owner\)/);
  assert.match(track, /SetForegroundWindow\(owner\)/);
  assert.match(track, /TrackPopupMenuEx\(/);
  assert.match(track, /TPM_RIGHTBUTTON/);
  assert.match(track, /PostMessageW\(Some\(owner\), WM_NULL/);
  assert.match(host, /AppendMenuW\(menu, MF_POPUP/);
  assert.match(host, /CheckMenuRadioItem/);
  assert.match(host, /menu\(menu_owner, &render\)/);
});

test('global show/hide shortcut avoids WeChat/QQ screenshot keys and stays in sync with the native registry', () => {
  const ui = readFileSync(new URL('./MonitorShortcutSettings.tsx', import.meta.url), 'utf8');
  const rust = readFileSync(new URL('../../src-tauri/src/monitor_shortcut.rs', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(rust, /DEFAULT: &str = "Ctrl\+Alt\+M"/);
  assert.match(rust, /PRESETS: \[&str; 4\] = \["Ctrl\+Alt\+M", "Ctrl\+Alt\+K", "Ctrl\+Shift\+M", ""\]/);
  assert.match(ui, /避开微信截图 Alt\+A 和 QQ 截图 Ctrl\+Alt\+A/);
  assert.match(ui, /role="alert"/);
  assert.match(app, /listen\('monitor-shortcut'/);
  assert.match(app, /preferences\.taskbarEnabled && current\.supported \? 'taskbar' : 'floating'/);
});
