/** Publish under the workflow's shared repository lock; never move a source tag. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRelease, semver, validateVersions } from './release-check.mjs';
import { ghJson } from './release-verify.mjs';
import { requireReleaseTagCommit } from './release-tag.mjs';

function checkRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('An explicit owner/repository is required.');
}

function versionParts(version) {
  const match = typeof version === 'string' && semver.exec(version);
  if (!match) throw new Error('A valid SemVer is required for stable release selection.');
  return { numbers: match.slice(1, 4).map(BigInt), prerelease: Boolean(match[4]) };
}

export function compareStableVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  if (a.prerelease || b.prerelease) throw new Error('Stable comparison cannot include a prerelease.');
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  // Build metadata does not change SemVer precedence.
  return 0;
}

/** Keep older/equal stable tags downloadable without replacing the update channel. */
export function latestDecision(version, releases) {
  if (versionParts(version).prerelease) return false;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const publishedVersion = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name;
    if (compareStableVersions(version, publishedVersion) <= 0) return false;
  }
  return true;
}

/** Read every bounded page; an incomplete inventory may never authorize promotion. */
export async function releaseInventory(repository, { fetchJson = ghJson, maxPages = 10 } = {}) {
  checkRepository(repository);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('Release inventory pagination must be bounded to 1–10 pages.');
  const releases = []; const ids = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const entries = await fetchJson(`/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Expected a release inventory page of at most 100 entries.');
    for (const release of entries) {
      if (!release || typeof release !== 'object' || Array.isArray(release)
        || !Number.isSafeInteger(release.id) || release.id < 1 || typeof release.tag_name !== 'string' || !release.tag_name
        || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('Release inventory metadata is invalid.');
      if (ids.has(release.id)) throw new Error('Duplicate release ID in the publication inventory.');
      ids.add(release.id); releases.push(release);
    }
    if (entries.length < 100) return releases;
  }
  throw new Error('Release inventory pagination limit reached before all published versions were checked.');
}

/** Use one structured PATCH for publication plus latest selection, with a finite deadline. */
export function patchPublication(repository, id, body, { execute = execFileSync } = {}) {
  checkRepository(repository);
  if (!Number.isSafeInteger(id) || id < 1 || body?.draft !== false || !['true', 'false'].includes(body.make_latest)
    || Object.keys(body).some(key => !['draft', 'make_latest'].includes(key))) throw new Error('Invalid release publication request.');
  return JSON.parse(execute('gh', ['api', '--method', 'PATCH', `/repos/${repository}/releases/${id}`, '--input', '-'], {
    input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000, killSignal: 'SIGKILL',
  }));
}

/** Caller must hold release-publish-${repository}; all signature/package gates run before this. */
export async function publishRelease({ repository = process.env.GITHUB_REPOSITORY, tag = process.env.RELEASE_TAG,
  expectedSha = process.env.GITHUB_SHA, version, fetchJson = ghJson, fetchTag = ghJson,
  patchRelease = patchPublication, logger = console.log } = {}) {
  checkRepository(repository);
  if (!version) ({ version } = await checkRelease({ tag }));
  validateVersions([{ file: 'release source', version }], tag);
  if (!tag) throw new Error('An explicit release tag is required.');
  const prerelease = versionParts(version).prerelease;
  await requireReleaseTagCommit(repository, tag, expectedSha, { fetchJson: fetchTag });
  const releases = await releaseInventory(repository, { fetchJson });
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.length !== 1 || matches[0].draft !== true) throw new Error('Expected exactly one unpublished draft for the verified source tag.');
  const draft = matches[0];
  if (draft.prerelease !== prerelease) throw new Error('Draft prerelease status does not match the source version.');
  const makeLatest = latestDecision(version, releases);
  // Recheck after the inventory read, immediately before the only write.
  await requireReleaseTagCommit(repository, tag, expectedSha, { fetchJson: fetchTag });
  const published = await patchRelease(repository, draft.id, { draft: false, make_latest: String(makeLatest) });
  if (!published || published.id !== draft.id || published.tag_name !== tag || published.draft !== false || published.prerelease !== prerelease) throw new Error('Publication response does not match the verified draft. Inspect the release before retrying.');
  logger(`Release published: ${repository} ${tag}; stable latest ${makeLatest ? 'advanced' : 'preserved'}.`);
  return { id: draft.id, tag, makeLatest, prerelease };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await publishRelease();
