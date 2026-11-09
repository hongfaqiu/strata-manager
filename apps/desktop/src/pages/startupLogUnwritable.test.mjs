import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Xiaohongshu feedback: Strata 0.2.1.x on Windows exits with
// PermissionError [Errno 13] on imports\local-*\engine.log. The card names the
// cause instead of "required file missing" and explains the one-file fallback.
test('an unwritable engine log gets its own title and the fallback note', () => {
  const card = source('./StartupDiagnosticCard.tsx');
  assert.match(card, /diagnostic\.code === 'STARTUP_LOG_UNWRITABLE'/);
  assert.match(card, /'日志文件被占用或无权限' : 'Log file in use or not writable'/);
  assert.match(card, /<strong>\{title\}<\/strong>/);
  assert.match(card, /logUnwritable && <p className="startup-diagnostic-retained">/);
});

test('the runtime classifies the log error with every repair step', () => {
  const runtime = source('../../../../crates/runtime-core/src/engine_log.rs');
  const message = runtime.match(/pub const UNWRITABLE_MESSAGE: &str = "([^"]+)"/)?.[1] ?? '';
  for (const step of ['日志文件被占用或无权限', '残留的 python / strata 进程', '只读', '完全控制权限', '360', '火绒', 'v0.2.1.x', 'Read-only', 'Full control', 'Huorong']) {
    assert.ok(message.includes(step), step);
  }
  assert.match(source('../../../../crates/runtime-core/src/lib.rs'), /原日志文件被占用或无权限，已改写到 \{\}/);
});

// A Windows user (2026-11) saw "the engine exited before it was ready" with VRAM mostly free:
// the engine had filled VRAM itself. The card names the shortage and offers the reserve fix.
test('a VRAM or commit shortage gets its own title, the free-VRAM note and the reserve fix', () => {
  const card = source('./StartupDiagnosticCard.tsx');
  assert.match(card, /'显存不够，模型没加载上' : 'Out of VRAM while loading the model'/);
  assert.match(card, /系统管理的大小/);
  assert.match(card, /System managed size/);
  assert.match(card, /不是别的程序占用/);
  assert.match(card, /保留显存提到 \$\{reserveFix\} MiB 并重启/);
  const app = source('../App.tsx');
  assert.match(app, /core\.startupVramReserveFix\(snapshot\.config\)/);
  assert.match(app, /await core\.writeConfig\(target, next, snapshot\.revision\)/);
  assert.match(app, /await activateLocal\(target\)/);
  // A hook below `if (!ready) return` crashes the app on first render ("Rendered more hooks").
  assert.ok(app.indexOf("useQuery({ queryKey: ['startupReserveFix'") < app.indexOf('if (serverMode && !serverAuthed) return <ServerAuthGate'));
});

// Upstream #5619: Win11 Smart App Control blocks strata-vision.exe / the main engine (WinError 4551).
test('a Smart App Control block gets its own title and the Windows Security note', () => {
  const card = source('./StartupDiagnosticCard.tsx');
  assert.match(card, /startupWindowsSacBlocked\(diagnostic\)/);
  assert.match(card, /'Windows 智能应用控制拦截了引擎' : 'Windows Smart App Control blocked the engine'/);
  assert.match(card, /data-testid="startup-diagnostic-sac"/);
  assert.match(card, /Windows 安全中心/);
  assert.match(card, /App & browser control/);
  assert.match(card, /strata-vision\.exe/);
});
