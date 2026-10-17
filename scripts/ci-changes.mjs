/**
 * Decide which CI job groups a pull request needs. Fail closed: anything that is
 * not a pull request, any unknown path and any git or input error runs everything.
 *   code   - desktop checks (frontend tests, clippy, release guard tests)
 *   native - Rust native shards, observer compatibility and coverage verification
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Changes that cannot affect the desktop app, its tests or the release evidence.
export const DOCUMENTATION_ONLY = Object.freeze([
  'README.md', 'README.*.md', 'design-qa.md', 'design/**', 'website/**',
  '.github/workflows/website.yml', 'scripts/build-website.mjs', 'scripts/website-*.mjs',
  'scripts/render-website-docs.mjs', 'scripts/render-website-docs.test.mjs',
]);
// Changes exercised by the desktop job's frontend/script tests but never compiled
// into, read by or used to set up a Rust native test binary.
export const FRONTEND_ONLY = Object.freeze([
  'apps/desktop/src/**', 'apps/desktop/tests/**', 'apps/desktop/public/**',
  'apps/desktop/index.html', 'apps/desktop/vite.config.ts', 'apps/desktop/tsconfig.json',
  'apps/desktop/dev-proxy.ts', 'apps/desktop/dev-proxy.test.mjs',
  'packages/**', 'tsconfig.base.json', 'CHANGELOG.md', 'docs/**',
  'scripts/contract-server.mjs', 'scripts/contract-server.test.mjs',
  'scripts/release-notes.mjs', 'scripts/release-notes.test.mjs',
  'scripts/installer-languages.test.mjs', 'scripts/capture-*.mjs',
  'scripts/screenshot-fixtures/**', 'scripts/design/**', 'scripts/render-product-hero.mjs',
]);
const FULL = Object.freeze({code: true, native: true});

function globRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') { source += '.*'; i++; }
    else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
const matchers = list => list.map(globRegExp);
const documentation = matchers(DOCUMENTATION_ONLY);
const frontend = matchers(FRONTEND_ONLY);
const validPath = file => typeof file === 'string' && file.length > 0 && file.length <= 4096
  && !file.startsWith('/') && !file.split('/').some(part => part === '' || part === '.' || part === '..')
  && !/[\x00-\x1f\x7f\\]/.test(file);

/** Classify repository-relative changed paths; an unknown path needs everything. */
export function classify(files) {
  if (!Array.isArray(files) || !files.length || !files.every(validPath)) return {...FULL, reason: 'unknown or empty change set'};
  let code = false; let native = false; const nativeFiles = [];
  for (const file of files) {
    if (documentation.some(m => m.test(file))) continue;
    code = true;
    if (frontend.some(m => m.test(file))) continue;
    native = true; nativeFiles.push(file);
  }
  const reason = native ? `native inputs changed: ${nativeFiles.slice(0, 5).join(', ')}${nativeFiles.length > 5 ? ', …' : ''}`
    : code ? 'only frontend, script or bundled-documentation inputs changed' : 'only website or repository documentation changed';
  return {code, native, reason};
}

/** Only an ordinary pull request may skip; main, manual and release builds always run everything. */
export function decide({event, labels = [], headRef = '', files}) {
  if (event !== 'pull_request') return {...FULL, reason: `${event || 'unknown'} events always run every job`};
  if (!Array.isArray(labels) || labels.includes('full-ci')) return {...FULL, reason: 'full-ci label'};
  if (typeof headRef !== 'string' || headRef.startsWith('release/')) return {...FULL, reason: 'release pull request'};
  return classify(files);
}

function git(args) { return execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024}); }

/** Files a pull request's merge commit changes relative to its current base parent. */
export function pullRequestFiles(expectedSha) {
  const head = git(['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40}$/.test(head) || head !== expectedSha) throw new Error('The checked-out commit differs from the workflow commit.');
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1);
  if (parents.length !== 2) throw new Error('A pull request merge commit with exactly two parents is required.');
  return git(['diff', '--name-only', '-z', '--no-renames', 'HEAD^1', 'HEAD']).split('\0').filter(Boolean);
}

export function main(env = process.env) {
  let decision;
  try {
    const event = env.GITHUB_EVENT_NAME;
    const labels = event === 'pull_request' ? JSON.parse(env.CI_PR_LABELS ?? 'null') : [];
    const files = event === 'pull_request' ? pullRequestFiles(env.GITHUB_SHA) : [];
    decision = decide({event, labels, headRef: env.CI_HEAD_REF ?? '', files});
    if (files.length) console.error(`Changed files (${files.length}):\n  ${files.join('\n  ')}`);
  } catch (error) {
    decision = {...FULL, reason: `change detection failed, running everything: ${error.message}`};
  }
  const lines = `code=${decision.code}\nnative=${decision.native}\n`;
  console.error(`code=${decision.code} native=${decision.native} (${decision.reason})`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**CI scope:** code=${decision.code}, native=${decision.native} — ${decision.reason}\n`);
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
