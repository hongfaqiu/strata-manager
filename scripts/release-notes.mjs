import { readFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semver } from './release-check.mjs';
import { localizedReleaseNotes } from '../apps/desktop/src/updateReleaseNotes.ts';

/** Release metadata must match this tag, never the unreleased or previous entry. */
export function releaseNotes(markdown, version) {
  if (typeof version !== 'string' || !semver.test(version)) throw new Error('A release SemVer is required.');
  const sections = [...markdown.matchAll(/^##[ \t]+\[([^\]]+)\].*$/gm)];
  const matching = sections.filter(section => section[1] === version);
  if (matching.length !== 1) throw new Error(`CHANGELOG.md must contain exactly one entry for ${version}.`);
  const section = matching[0];
  const next = sections.find(candidate => candidate.index > section.index);
  const notes = markdown.slice(section.index + section[0].length, next?.index ?? markdown.length).trim();
  if (!localizedReleaseNotes(notes, 'zh-CN') || !localizedReleaseNotes(notes, 'en')) throw new Error(`Release ${version} requires nonempty Chinese and English changelog sections.`);
  return notes;
}

/** GitHub release pages need immutable image URLs; updater notes keep repository-relative paths. */
export function githubReleaseNotes(notes, sourceSha) {
  if (typeof notes !== 'string' || typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('Release notes and a full lowercase source SHA are required.');
  }
  const prefix = `https://raw.githubusercontent.com/hongfaqiu/strata-manager/${sourceSha}/`;
  return notes.replace(/\]\(([^\r\n)]*)\)/g, (link, destination) => {
    const target = /^[ \t]*(?:<([^<>]*)>|([^ \t]+))/.exec(destination);
    if (!target) return link;
    const path = target[1] ?? target[2];
    let candidate = path;
    try { candidate = decodeURIComponent(candidate); } catch { /* The canonical-prefix check below still rejects malformed screenshot paths. */ }
    candidate = candidate.replaceAll('\\', '/');
    if (!/^(?:\.{1,2}\/|\/)*docs\/screenshots(?:\/|$)/.test(candidate)) return link;
    if (!/^docs\/screenshots\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(path)) {
      throw new Error('Release screenshot links must use a safe repository-relative WebP path.');
    }
    return `](${destination.replace(path, prefix + path)})`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const versionIndex = process.argv.indexOf('--version');
  if (versionIndex < 0 || !process.argv[versionIndex + 1]) throw new Error('Use --version <SemVer> to select the changelog entry.');
  const notes = releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), process.argv[versionIndex + 1]);
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `release_notes_${randomUUID().replaceAll('-', '')}`;
    appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${notes}\n${delimiter}\n`, 'utf8');
  } else process.stdout.write(`${notes}\n`);
}
