/** Show the candidate release's original Markdown regardless of interface language. */
export function releaseNotes(notes: string | undefined): string | null {
  return notes?.trim() || null;
}

/** Prefer the requested section when the publisher supplies localized Markdown. */
export function localizedReleaseNotes(notes: string | undefined, language: 'zh-CN' | 'en'): string | null {
  if (!notes?.trim()) return null;
  const sections = [...notes.matchAll(/^#{1,6}[ \t]+(中文|简体中文|Chinese|zh-CN|English|英文|en)[ \t]*\r?$/gmi)];
  const isChinese = (label: string) => /^(?:中文|简体中文|Chinese|zh-CN)$/i.test(label);
  const matching = sections.filter(section => isChinese(section[1]!) === (language === 'zh-CN'));
  if (matching.length !== 1) return null;
  const section = matching[0]!;
  const next = sections.find(candidate => candidate.index! > section.index!);
  return notes.slice(section.index! + section[0].length, next?.index ?? notes.length).trim() || null;
}
