/**
 * Regenerate scripts/native-test-timings.json from the native shard job logs of one CI run.
 *
 *   node scripts/native-test-timings.mjs --run <workflow-run-id> [--repo owner/name] [--write]
 *
 * Native shards run libtest with --test-threads=1 and --format pretty, so the gap between a
 * "test <name> ... ok" line and the previous result (or "running N tests") is that test's
 * wall time. Timings are scheduling hints only; no test deadline or assertion depends on them.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TIMINGS_FILE = resolve(root, 'scripts/native-test-timings.json');
// Tests at or above this many seconds are recorded individually; the rest only as module totals.
export const MIN_TEST_SECONDS = 1;
const moduleOf = name => name.includes('::') ? name.slice(0, name.lastIndexOf('::')) : '(root)';
const round = seconds => Math.round(seconds * 10) / 10;
const byKey = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

/** Parse one GitHub Actions job log into [{binary, name, seconds}] for passed tests. */
export function parseShardLog(text) {
  const results = []; let binary; let previous;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/.exec(raw);
    if (!line) continue;
    const at = Date.parse(line[1]); const message = line[2].trim();
    const group = /^Native group \d+: (\S+), batch \d+\/\d+ /.exec(message);
    if (group) { binary = group[1]; previous = undefined; continue; }
    if (/^running \d+ tests?$/.test(message)) { previous = at; continue; }
    const result = /^test (\S+) \.\.\. (ok|ignored|FAILED)\b/.exec(message);
    if (!result || !binary || previous === undefined) continue;
    if (result[2] === 'ok') results.push({binary, name: result[1], seconds: Math.max(0, (at - previous) / 1000)});
    previous = at;
  }
  return results;
}

/** Fold parsed results into {modules: {binary: {module: [seconds, tests]}}, tests: {binary: {name: seconds}}}. */
export function summarize(results, minTestSeconds = MIN_TEST_SECONDS) {
  const modules = {}; const tests = {}; const seen = new Set();
  for (const {binary, name, seconds} of results) {
    const key = `${binary}\0${name}`;
    if (seen.has(key)) continue; // a retried test keeps its first measurement
    seen.add(key);
    const module = moduleOf(name);
    const entry = ((modules[binary] ??= {})[module] ??= [0, 0]);
    entry[0] += seconds; entry[1]++;
    if (seconds >= minTestSeconds) (tests[binary] ??= {})[name] = round(seconds);
  }
  for (const binary of Object.keys(modules)) for (const module of Object.keys(modules[binary])) modules[binary][module][0] = round(modules[binary][module][0]);
  return {
    modules: byKey(Object.fromEntries(Object.entries(modules).map(([b, m]) => [b, byKey(m)]))),
    tests: byKey(Object.fromEntries(Object.entries(tests).map(([b, t]) => [b, byKey(t)]))),
  };
}

function gh(args) { return execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024}); }

async function main(argv) {
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const run = value('--run'); const repo = value('--repo') ?? 'hongfaqiu/strata-manager';
  if (!/^[1-9]\d*$/.test(run ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Usage: --run <workflow-run-id> [--repo owner/name] [--write]');
  const jobs = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run}/jobs?per_page=100`])).flatMap(page => page.jobs);
  const platforms = {linux: /^Linux native shard \(\d+\/\d+\)$/, win32: /^Windows native shard \(\d+\/\d+\)$/};
  const output = {source: {repository: repo, runId: Number(run)}};
  for (const [platform, pattern] of Object.entries(platforms)) {
    const shardJobs = jobs.filter(job => pattern.test(job.name));
    if (!shardJobs.length || shardJobs.some(job => job.conclusion !== 'success')) throw new Error(`Run ${run} has no fully successful ${platform} native shards.`);
    const results = shardJobs.flatMap(job => parseShardLog(gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.id}/logs`])));
    output[platform] = summarize(results);
    const total = results.reduce((sum, r) => sum + r.seconds, 0);
    console.log(`${platform}: ${shardJobs.length} shards, ${results.length} passed tests, ${round(total)} s of test time`);
  }
  const text = `${JSON.stringify(output, null, 1).replace(/\[\n\s*([\d.]+),\n\s*(\d+)\n\s*\]/g, '[$1, $2]')}\n`;
  if (argv.includes('--write')) { writeFileSync(TIMINGS_FILE, text); console.log(`Wrote ${TIMINGS_FILE}`); }
  else process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
