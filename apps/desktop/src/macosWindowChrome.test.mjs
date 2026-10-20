import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { currentWindowChrome, detectWindowChrome } from './windowChrome.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const titleBar = read('./WindowTitleBar.tsx');
const css = read('./window-title-bar.css');
const main = read('./main.tsx');
const lib = read('../src-tauri/src/lib.rs');
const menu = read('../src-tauri/src/app_menu.rs');
const base = JSON.parse(read('../src-tauri/tauri.conf.json'));
const mac = JSON.parse(read('../src-tauri/tauri.macos.conf.json'));

// User report (Mac): the app showed Windows-style buttons in the top-right corner.
test('only a Mac desktop window uses native traffic lights', () => {
  assert.equal(detectWindowChrome({ desktop: true, platform: 'MacIntel' }), 'macos');
  assert.equal(detectWindowChrome({ desktop: true, platform: 'macOS' }), 'macos');
  assert.equal(detectWindowChrome({ desktop: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' }), 'macos');
  assert.equal(detectWindowChrome({ desktop: true, platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130' }), 'custom');
  assert.equal(detectWindowChrome({ desktop: true, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15' }), 'custom');
  // A browser on a Mac (server mode / dev) has no native window to decorate.
  assert.equal(detectWindowChrome({ desktop: false, platform: 'MacIntel' }), 'custom');
  assert.equal(detectWindowChrome({ desktop: false, override: 'macos' }), 'macos');
  assert.equal(currentWindowChrome({ dataset: { windowChrome: 'macos' } }), 'macos');
  assert.equal(currentWindowChrome({ dataset: {} }), 'custom');
  assert.equal(currentWindowChrome(null), 'custom');
});

test('the macOS header renders no custom window buttons; Windows/Linux keep them', () => {
  assert.match(titleBar, /const nativeControls = chrome === 'macos';/);
  assert.match(titleBar, /\{!nativeControls && <div className="window-title-bar-controls"/);
  assert.match(titleBar, /data-chrome=\{chrome\} data-fullscreen=\{nativeControls \? fullscreen : undefined\}/);
  // Full screen hides the lights, so the header tracks it to drop the inset.
  assert.match(titleBar, /nativeControls \? window\.isFullscreen\(\) : false/);
  // The whole header stays a drag region; double-click zoom comes from Tauri's drag script.
  assert.match(titleBar, /data-tauri-drag-region=\{desktop \? 'deep' : undefined\}/);
  assert.match(main, /if \(!monitorWindow\) document\.documentElement\.dataset\.windowChrome = detectWindowChrome\(/);
  assert.match(main, /override: import\.meta\.env\.DEV \?/);
});

test('the header and sidebar leave room for the traffic lights except in full screen', () => {
  assert.match(css, /\.window-title-bar\[data-chrome="macos"\]:not\(\[data-fullscreen="true"\]\) \.window-title-bar-brand\{padding-left:var\(--window-traffic-light-inset\)/);
  assert.match(css, /--window-traffic-light-inset:86px;--window-nav-collapsed-width:88px/);
  assert.match(css, /:root\[data-window-chrome="macos"\] \.manager-shell\{--manager-nav-collapsed-width:88px\}/);
  // Lights: x=18 + three 14px buttons 20px apart = 72px, inset 86px leaves a 14px gap.
  assert.ok(mac.app.windows[0].trafficLightPosition.x + 54 + 14 <= 86);
});

test('macOS window config differs from the base only in native chrome keys', () => {
  const [baseMain] = base.app.windows;
  const [macMain] = mac.app.windows;
  assert.equal(mac.app.windows.length, base.app.windows.length);
  assert.equal(baseMain.decorations, false, 'Windows/Linux stay borderless');
  const { decorations, titleBarStyle, hiddenTitle, trafficLightPosition, ...rest } = macMain;
  const { decorations: _, ...baseRest } = baseMain;
  assert.deepEqual(rest, baseRest, 'platform config replaces the whole windows array, so keep it in sync');
  assert.equal(decorations, true);
  assert.equal(titleBarStyle, 'Overlay');
  assert.equal(hiddenTitle, true);
  assert.deepEqual(Object.keys(trafficLightPosition).sort(), ['x', 'y']);
});

test('macOS gets a native menu so Cmd+C/V/Q/W/M/H work', () => {
  assert.match(lib, /#\[cfg\(target_os = "macos"\)\]\s*app_menu::install\(app, english\)\?;/);
  for (const item of ['undo', 'redo', 'cut', 'copy', 'paste', 'select_all', 'minimize', 'close_window', 'hide', 'fullscreen']) {
    assert.match(menu, new RegExp(`PredefinedMenuItem::${item}\\(`), item);
  }
  // Cmd+Q runs the same clean-up as the tray's Quit.
  assert.match(menu, /MenuItem::with_id\(handle, QUIT_ID, &text\.quit, true, Some\("CmdOrCtrl\+Q"\)\)/);
  assert.match(menu, /crate::quit_interface\(app\)/);
  assert.match(lib, /"quit" => quit_interface\(app\),/);
  // Clicking the Dock icon brings back a window hidden to the menu bar.
  assert.match(lib, /if let tauri::RunEvent::Reopen \{ \.\. \} = event \{\s*show_interface\(handle\);/);
});
