import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const lib = read('../src-tauri/src/lib.rs');
const taskbar = read('../src-tauri/src/taskbar_monitor.rs');
const policy = read('../src-tauri/src/invoke_policy.rs');
const strip = read('./FloatingTelemetryWindow.tsx');
const bridge = read('./floatingMonitor.ts');
const settings = read('./pages/FloatingMonitorSettings.tsx');
const app = read('./App.tsx');
const server = read('../../server/src/rpc.rs');

test('the separate "托盘监控" icon is gone: the app owns exactly one plain tray icon', () => {
  assert.equal(existsSync(new URL('../src-tauri/src/monitor_tray.rs', import.meta.url)), false);
  assert.doesNotMatch(lib, /monitor_tray/);
  const trays = [...lib.matchAll(/TrayIconBuilder::with_id\("([^"]+)"\)/g)].map(match => match[1]);
  assert.deepEqual(trays, ['main-tray']);
  // The remaining icon is the application icon, never a generated readout.
  assert.match(lib, /TrayIconBuilder::with_id\("main-tray"\)\s*\.icon\(app\.default_window_icon\(\)/);
  for (const source of [lib, taskbar, policy, strip, bridge, settings, app, server]) {
    assert.doesNotMatch(source, /托盘监控|minimize_monitor_to_tray|minimizeMonitorToTray|monitor-tray-preference|showInTray|在系统托盘显示监控/);
  }
});

test('the strip collapses into the taskbar monitor instead of the tray', () => {
  assert.match(strip, /operation === 'taskbar' \? text\('收起到任务栏监控', 'Move to taskbar monitor'\)/);
  assert.doesNotMatch(strip, /收起到系统托盘|Move to system tray/);
  // Offered only where the taskbar widget exists (Windows).
  assert.match(strip, /\.\.\.\(taskbarSupported \? \[\{ id: 'taskbar'/);
  assert.match(bridge, /invoke\('move_monitor_to_taskbar'/);
  assert.match(lib, /taskbar_monitor::move_monitor_to_taskbar,/);
  for (const list of [policy, server]) assert.match(list, /"move_monitor_to_taskbar"/);
  // Remembered for the next launch, like the settings switch.
  const command = taskbar.slice(taskbar.indexOf('pub(crate) async fn move_monitor_to_taskbar'), taskbar.indexOf('async fn set_mode_locked'));
  assert.match(command, /window\.label\(\) != crate::floating_monitor::LABEL/);
  assert.match(command, /set_mode_locked\(&app, "taskbar", preferences\)/);
  assert.match(command, /"monitor-preferences-patch",\s*json!\(\{"taskbarEnabled": true\}\)/);
});

test('settings no longer offer a tray-monitor switch and old saved values are dropped', () => {
  assert.doesNotMatch(settings, /普通托盘图标|Standard tray icon|floating-monitor-settings-more/);
  assert.match(app, /floatingMonitor: s === null \? core\.firstRunFloatingMonitorPreferences\(firstRunTaskbar\) : \{\.\.\.core\.withoutRetiredFloatingMonitorKeys\(s\?\.floatingMonitor\)/);
});

test('new Windows installs start with the taskbar monitor on; saved settings are untouched', () => {
  // Only when nothing was saved yet, and only where the native widget is supported (Windows).
  assert.match(app, /const firstRunTaskbar = s === null && tauriShell && !serverMode \? await readMonitorModeStatus\(\)\.then\(status => status\.supported === true\)/);
  assert.match(app, /floatingMonitor: s === null \? core\.firstRunFloatingMonitorPreferences\(firstRunTaskbar\) : \{\.\.\.core\.withoutRetiredFloatingMonitorKeys\(s\?\.floatingMonitor\), \.\.\.normalizeFloatingMonitorPreferences\(s\?\.floatingMonitor\)\}/);
  // Shown right after the first-run language step, not only on the next launch.
  assert.match(app, /if \(firstRunTaskbarStart\.current && preferences\.taskbarEnabled\) \{[\s\S]*?setMonitorVisibility\(true, 'taskbar'/);
  // Next launches restore it from the saved switch, as for any user who turned it on.
  assert.match(taskbar, /settings\["floatingMonitor"\]\["taskbarEnabled"\] == true/);
});
