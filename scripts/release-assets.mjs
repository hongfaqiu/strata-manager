/** Refuse invalid release uploads before building or replacing draft assets. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseInventory } from './release-publish.mjs';
import { requireReleaseTagCommit } from './release-tag.mjs';
import { ghJson } from './release-verify.mjs';

/** Read-only guard. An external publication after this read still needs server-side protection. */
export async function requireReleaseAssetsWritable({ repository = process.env.GITHUB_REPOSITORY,
  tag = process.env.RELEASE_TAG, expectedSha = process.env.GITHUB_SHA, requireDraft = false,
  fetchJson = ghJson, fetchTag = ghJson, maxPages = 10, logger = console.log } = {}) {
  if (typeof requireDraft !== 'boolean') throw new Error('requireDraft must be a boolean.');
  const source = await requireReleaseTagCommit(repository, tag, expectedSha, { fetchJson: fetchTag });
  const releases = await releaseInventory(repository, { fetchJson, maxPages });
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.length > 1) throw new Error('Duplicate releases exist for the source tag; uploads are forbidden.');
  if (matches[0]?.draft === false) throw new Error('The source tag is already publicly released; uploads and reruns are forbidden.');
  if (requireDraft && matches.length !== 1) throw new Error('Expected exactly one unpublished draft before replacing release assets.');
  // Bind the source again after the complete inventory has been read.
  await requireReleaseTagCommit(repository, tag, expectedSha, { fetchJson: fetchTag });
  const releaseId = matches[0]?.id ?? null;
  logger(`Release upload allowed: ${repository} ${tag} -> ${source}; ${releaseId === null ? 'new draft required' : `unpublished draft ${releaseId}`}.`);
  return { tag, source, releaseId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(argument => argument !== '--require-draft')) throw new Error('Only --require-draft is supported.');
  await requireReleaseAssetsWritable({ requireDraft: args.includes('--require-draft') });
}
