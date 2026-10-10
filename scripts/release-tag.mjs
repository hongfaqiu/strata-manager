/** Resolve an existing release tag; never create or change a GitHub ref. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const maximumTagDepth = 8;

function checkedSha(value, label) {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${label} must be a full Git object SHA.`);
  return value.toLowerCase();
}

function checkRepositoryAndTag(repository, tag) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('An explicit owner/repository is required.');
  // Git ref rules, plus a finite API-path length. A slash inside a tag remains
  // a single encoded component in the exact-reference endpoint below.
  if (typeof tag !== 'string' || !tag || tag.length > 255 || tag === '@'
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(tag) || tag.includes('..') || tag.includes('@{')
    || tag.endsWith('.') || tag.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('A valid, explicit Git tag name is required.');
  }
}

function checkedObject(object, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || !['commit', 'tag'].includes(object.type)) throw new Error(`${label} must reference a commit or annotated tag.`);
  return { type: object.type, sha: checkedSha(object.sha, `${label} SHA`) };
}

/** All metadata requests are read-only, bounded and use this exact repository. */
export function ghTagJson(path, { execute = execFileSync } = {}) {
  return JSON.parse(execute('gh', ['api', path], {
    encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 30000, killSignal: 'SIGKILL',
  }));
}

/** Peel lightweight or annotated tags without treating release metadata as source identity. */
export async function resolveReleaseTagCommit(repository, tag, { fetchJson = ghTagJson, maxTagDepth = maximumTagDepth } = {}) {
  checkRepositoryAndTag(repository, tag);
  if (!Number.isSafeInteger(maxTagDepth) || maxTagDepth < 1 || maxTagDepth > maximumTagDepth) throw new Error('Annotated tag depth must be bounded to 1–8.');
  const reference = await fetchJson(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) || reference.ref !== `refs/tags/${tag}`) throw new Error('Expected the exact existing release tag reference.');
  let object = checkedObject(reference.object, 'Release tag reference');
  const visited = new Set();
  let depth = 0;
  while (object.type === 'tag') {
    if (visited.has(object.sha)) throw new Error('Annotated tag cycle detected.');
    if (depth >= maxTagDepth) throw new Error('Annotated tag depth limit reached before a commit was found.');
    visited.add(object.sha); depth += 1;
    const annotated = await fetchJson(`/repos/${repository}/git/tags/${object.sha}`);
    if (!annotated || typeof annotated !== 'object' || Array.isArray(annotated)
      || checkedSha(annotated.sha, 'Annotated tag SHA') !== object.sha) throw new Error('Annotated tag metadata does not match the requested object.');
    object = checkedObject(annotated.object, 'Annotated tag target');
  }
  return object.sha;
}

/** Refuse missing/moved tags before asset uploads or publication can proceed. */
export async function requireReleaseTagCommit(repository, tag, expectedSha, options = {}) {
  const expected = checkedSha(expectedSha, 'Expected release commit');
  const actual = await resolveReleaseTagCommit(repository, tag, options);
  if (actual !== expected) throw new Error('The existing release tag commit does not match the expected source commit.');
  return actual;
}

export async function checkReleaseTagEnvironment({ env = process.env, fetchJson = ghTagJson, logger = console.log } = {}) {
  const { GITHUB_REPOSITORY: repository, RELEASE_TAG: tag, GITHUB_SHA: expectedSha } = env;
  const actual = await requireReleaseTagCommit(repository, tag, expectedSha, { fetchJson });
  logger(`Release source verified: ${repository} ${tag} -> ${actual}.`);
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await checkReleaseTagEnvironment();
