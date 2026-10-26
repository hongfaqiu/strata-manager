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
