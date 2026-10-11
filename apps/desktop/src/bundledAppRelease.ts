export interface BundledAppRelease {
  version: string;
  notes: string;
  date?: string;
}

/** Match the installed version exactly; development and other releases are separate. */
export function bundledAppRelease(changelog: string, version: string): BundledAppRelease | null {
  const normalizedVersion = version.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalizedVersion)) return null;
  const sections = [...changelog.matchAll(/^##[ \t]+\[([^\]]+)\]([^\r\n]*)\r?$/gm)];
  const matching = sections.filter(section => section[1] === normalizedVersion);
  if (matching.length !== 1) return null;
  const section = matching[0]!;
  const next = sections.find(candidate => candidate.index! > section.index!);
  const notes = changelog.slice(section.index! + section[0].length, next?.index ?? changelog.length).trim();
  if (!notes) return null;
  const date = section[2]?.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  return { version: normalizedVersion, notes, ...(date ? { date } : {}) };
}
