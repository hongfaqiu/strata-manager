import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./runtimeUpdateProgress.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports, Intl, Number, Math, String, Date });
const p = module.exports;
const MiB = 1024 * 1024, total = 137300495, t0 = 1_700_000_000_000;
const states = model => Array.from(model.stages, stage => stage.state);
const line = (offset, message) => ({ timestamp: t0 + offset, level: 'info', message });
const task = (patch = {}) => ({ state: 'running', message: '', startedAt: t0, ...patch });
const header = [
  line(0, `正在下载官方Release v0.1.44：strata-windows-x64-cuda12.zip（${total}字节）及同提交源码`),
  line(1500, '官方同版本源码已下载 4718592 字节'),
  line(3000, '正在安全解包同版本源码并核验统计观察器兼容性'),
  line(5000, `源码兼容检查通过；正在下载官方strata-windows-x64-cuda12.zip（${total}字节），完成后核验官方SHA256`),
];
const progress = (from, seconds, perSecond, start = 0) => Array.from({ length: seconds }, (_, i) => line(from + (i + 1) * 1000, `下载进度：${start + perSecond * (i + 1)} / ${total} 字节`));

test('formats sizes with sensible precision and locale separators', () => {
  assert.equal(p.formatBytes(0), '0 B');
  assert.equal(p.formatBytes(999), '999 B');
  assert.equal(p.formatBytes(820 * 1024), '820 KB');
  assert.equal(p.formatBytes(8.42 * MiB), '8.42 MB');
  assert.equal(p.formatBytes(85.34 * MiB), '85.3 MB');
  assert.equal(p.formatBytes(total), '131 MB');
  assert.equal(p.formatBytes(1.27 * 1024 ** 3), '1.27 GB');
  assert.equal(p.formatBytes(8.42 * MiB, 'de'), '8,42 MB');
  assert.equal(p.formatBytes(-1), '—');
  assert.equal(p.formatRate(7.4 * MiB), '7.40 MB/s');
});

test('percent never reads 100% before the last byte', () => {
  assert.equal(p.formatPercent(total - 1, total), '99%');
  assert.equal(p.formatPercent(total, total), '100%');
  assert.equal(p.formatPercent(0.052 * total, total), '5.2%');
  assert.equal(p.formatPercent(10, undefined), undefined);
});

test('eta and elapsed formatting are stable and localised', () => {
  assert.equal(p.estimateEta(50, 100, undefined), undefined);
  assert.equal(p.estimateEta(100, 100, 5), undefined);
  assert.equal(p.estimateEta(0, 100 * MiB, 10 * MiB), 10);
  assert.equal(p.estimateEta(0, 100 * MiB, 50 * MiB), 5, 'rounded up to 5 s steps, at least 5 s');
  assert.equal(p.estimateEta(0, 100 * MiB, 1 * MiB), 120, 'whole minutes past one minute');
  assert.equal(p.formatEta(10, 'en'), '10 seconds');
  assert.equal(p.formatEta(120, 'en'), '2 minutes');
  assert.equal(p.formatEta(120, 'zh-CN'), '2分钟');
  assert.equal(p.formatEta(5400, 'en'), '1.5 hours');
  assert.equal(p.formatClock(65_000), '1:05');
  assert.equal(p.formatClock(3_725_000), '1:02:05');
});

test('rate is the trailing least-squares slope and smoothing moves gradually', () => {
  const samples = Array.from({ length: 12 }, (_, i) => ({ at: t0 + i * 1000, bytes: i * 8 * MiB }));
  assert.ok(Math.abs(p.estimateRate(samples) - 8 * MiB) < 1);
  assert.equal(p.estimateRate(samples.slice(0, 1)), undefined, 'one sample has no rate');
  assert.equal(p.estimateRate([{ at: t0, bytes: 0 }, { at: t0 + 500, bytes: MiB }]), undefined, 'too short a span');
  // A late log line (2 s gap, double bytes) does not spike the estimate.
  const jitter = [...samples.slice(0, 10), { at: t0 + 11_000, bytes: 11 * 8 * MiB }];
  assert.ok(Math.abs(p.estimateRate(jitter) - 8 * MiB) < 0.05 * 8 * MiB);
  const smoothed = p.smoothRate(10, 20, 3000, 3000);
  assert.ok(smoothed > 16 && smoothed < 17, 'about 63% of the way after one time constant');
  assert.equal(p.smoothRate(undefined, 20, 1000), 20);
  assert.equal(p.smoothRate(12, undefined, 1000), 12);
});

test('download samples restart after a retry drops the byte count', () => {
  const lines = [...progress(5000, 5, 4 * MiB), line(11_000, `下载重试 2/4：下载中断: reset；已保存 ${20 * MiB} 字节`), ...progress(12_000, 3, 2 * MiB)];
  const samples = p.downloadSamples(lines);
  assert.equal(samples.length, 3, 'only the resumed attempt is used');
  assert.equal(samples[0].bytes, 2 * MiB);
  assert.equal(p.rateSeries(samples).length, 2);
});

test('stage timeline follows the backend lines and keeps stage durations', () => {
  const lines = [...header, ...progress(5000, 9, 8 * MiB)];
  const model = p.deriveUpdateProgress(task({ message: lines.at(-1).message }), lines, t0 + 14_200);
  assert.equal(model.current, 'download');
  assert.deepEqual(states(model), ['done', 'active', 'pending', 'pending', 'pending']);
  assert.equal(model.stages[0].endedAt - model.stages[0].startedAt, 5000);
  assert.equal(model.version, '0.1.44');
  assert.equal(model.download.received, 9 * 8 * MiB);
  assert.equal(model.download.total, total);
  assert.equal(model.download.declared, 'server');
  assert.ok(Math.abs(p.estimateRate(model.samples) - 8 * MiB) < 1);
  assert.equal(model.sourceReceived, 4718592);
});

test('verification, extraction, replacement and restore map onto the five stages', () => {
  const tail = [line(30_000, 'SHA256 校验通过，共 137300495 字节')];
  let model = p.deriveUpdateProgress(task(), [...header, ...progress(5000, 3, 40 * MiB), ...tail]);
  assert.equal(model.current, 'download'); assert.equal(model.detail, 'verified'); assert.equal(model.download.verified, true);
  model = p.deriveUpdateProgress(task(), [...header, ...tail, line(31_000, '官方引擎SHA256和精确长度通过；正在安全解包运行文件'), line(32_000, '正在验证Python依赖及新版服务源码语法')]);
  assert.equal(model.current, 'extract'); assert.equal(model.detail, 'checkingPython');
  model = p.deriveUpdateProgress(task(), [...header, line(33_000, '正在等待受管服务请求完成；准备停止本应用拥有的服务'), line(34_000, '正在验证Python依赖及新版服务源码语法')]);
  assert.equal(model.current, 'apply', 'a later Python check never moves the timeline back');
  model = p.deriveUpdateProgress(task(), [...header, line(35_000, '源码与引擎已同步替换；正在恢复原受管服务状态')]);
  assert.equal(model.current, 'restore');
  assert.deepEqual(states(model), ['done', 'done', 'done', 'done', 'active'], 'skipped lines still mark earlier stages done');
  model = p.deriveUpdateProgress(task({ state: 'completed', finishedAt: t0 + 40_000, message: 'Strata已更新至官方Release v0.1.44；模型、配置及会话已保留' }), [...header]);
  assert.ok(model.stages.every(stage => stage.state === 'done'));
});

test('failure marks the stage that stopped and records rollback', () => {
  const lines = [...header, line(33_000, '正在等待受管服务请求完成；准备停止本应用拥有的服务'), line(34_000, '更新未完成，正在恢复原程序文件和受管服务'), line(36_000, '原程序文件已恢复，模型与配置保持原位；更新可重试')];
  const running = p.deriveUpdateProgress(task(), lines.slice(0, -1));
  assert.equal(running.rollingBack, true); assert.equal(running.rolledBack, false); assert.equal(running.detail, 'rollingBack');
  const failed = p.deriveUpdateProgress(task({ state: 'failed', finishedAt: t0 + 37_000, message: '新版服务健康检查超时；已恢复原程序版本' }), lines);
  assert.equal(failed.rolledBack, true);
  assert.deepEqual(states(failed), ['done', 'done', 'done', 'failed', 'pending']);
  const cancelled = p.deriveUpdateProgress(task({ state: 'cancelled', message: '更新已取消，原服务保持运行' }), [...header, ...progress(5000, 2, MiB)]);
  assert.equal(cancelled.stages[1].state, 'failed');
});

test('unknown totals stay indeterminate; a manifest size is used when the server omits one', () => {
  const unknownHeader = [line(0, '正在下载官方Release v0.1.44：engine.zip及同提交源码'), line(5000, '源码兼容检查通过；正在下载官方engine.zip，完成后核验官方SHA256')];
  const unknown = p.deriveUpdateProgress(task(), [...unknownHeader, line(6000, `下载进度：${12 * MiB} 字节 / 总量未知`)]);
  assert.equal(unknown.current, 'download'); assert.equal(unknown.download.total, undefined); assert.equal(unknown.download.declared, 'unknown');
  const manifest = p.deriveUpdateProgress(task(), [...header, line(6000, `下载进度：${12 * MiB} 字节 / 总量未知`)]);
  assert.equal(manifest.download.total, total); assert.equal(manifest.download.declared, 'manifest');
});

test('retry lines are recognised and unknown lines are passed through verbatim', () => {
  const model = p.deriveUpdateProgress(task(), [...header, ...progress(5000, 2, MiB), line(8000, `下载重试 2/4：下载中断: reset；已保存 ${2 * MiB} 字节`)]);
  assert.equal(model.detail, 'retry'); assert.deepEqual({ ...model.retry }, { attempt: 2, max: 4 });
  const resumed = p.deriveUpdateProgress(task(), [...header, line(8000, `下载重试 2/4：下载中断: reset；已保存 ${2 * MiB} 字节`), ...progress(9000, 2, MiB, 2 * MiB)]);
  assert.equal(resumed.detail, undefined); assert.deepEqual({ ...resumed.retry }, { attempt: 2, max: 4 }, 'resumed download keeps the attempt note');
  const raw = p.deriveUpdateProgress(task({ message: '某个新的后端提示' }), header);
  assert.equal(raw.rawDetail, '某个新的后端提示'); assert.equal(raw.current, 'download');
  assert.deepEqual({ ...p.parseUpdateLine('无关内容') }, {});
});

test('humanises raw byte counts in task messages', () => {
  assert.equal(p.humanizeTaskMessage(`下载进度：${85 * MiB} / ${total} 字节`), '下载进度：85.0 MB / 131 MB');
  assert.equal(p.humanizeTaskMessage(`下载进度：${12 * MiB} 字节 / 总量未知`), '下载进度：12.0 MB / 总量未知');
  assert.equal(p.humanizeTaskMessage(`正在下载官方 engine.zip（${total}字节）`), '正在下载官方 engine.zip（131 MB）');
  assert.equal(p.humanizeTaskMessage('已读取本地 ZIP 1048576/137300495 字节'), '已读取本地 ZIP 1.00 MB / 131 MB');
  assert.equal(p.humanizeTaskMessage('下载重试 2/4：已保存 2097152 字节'), '下载重试 2/4：已保存 2.00 MB', 'small ratios such as 2/4 are left alone');
});

test('a status line older than the fetched log does not reset the download samples', () => {
  const lines = [...header, ...progress(5000, 6, 8 * MiB)];
  const model = p.deriveUpdateProgress(task({ message: lines.at(-3).message }), lines, t0 + 11_500);
  assert.equal(model.samples.length, 6);
  assert.equal(model.download.received, 6 * 8 * MiB);
  const ahead = p.deriveUpdateProgress(task({ message: `下载进度：${7 * 8 * MiB} / ${total} 字节` }), lines, t0 + 12_000);
  assert.equal(ahead.download.received, 7 * 8 * MiB, 'a newer status line is still used');
});
