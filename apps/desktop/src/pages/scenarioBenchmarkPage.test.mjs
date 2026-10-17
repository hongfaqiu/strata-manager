import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('./ScenarioBenchmarkPage.tsx', import.meta.url), 'utf8');

test('scenario page shows every section directly instead of folding it', () => {
  assert.doesNotMatch(page, /<details|<summary/);
  assert.doesNotMatch(page, /showRunningSettings/);
});

test('scenario page keeps every existing control and result after the redesign', () => {
  const features = [
    "'测试轮数'", "'每轮最大输出 token'", "'长输入字符数'", "'连续对话轮数'", "'每轮超时（秒）'", "'输入模式'", "'测试提示词'",
    "'先预热一次'", "'发生错误后停止'", "'开始测试'", "'停止测试'", "'测试说明'", "'导出 JSON'", "'导出 CSV'", "'导出时包含测试文本与输出'",
    "'历史测试'", "'筛选场景'", "'分场景对比'", "'错误分类'", "'请求样本'", "'测试条件'", "'资源趋势'", "'实时测试进度'", "<BenchmarkComparisonPanel",
    "'整卡显存峰值'", "'整机 RAM 峰值'", "'达到输出上限'", "P99", "'输出片段'", "quickRunRequest", "arenaAfterBenchmark", "'benchmarkUpgradeBaseline'",
  ];
  for (const feature of features) assert.ok(page.includes(feature), feature);
});

test('live progress shows the request in flight and an estimate derived from measured requests', () => {
  assert.match(page, /progress\?\.current/);
  assert.match(page, /'预计剩余'/);
  assert.match(page, /scenario-tracker/);
  assert.match(page, /RequestDotPlot/);
  assert.match(page, /ScenarioColumns/);
});
