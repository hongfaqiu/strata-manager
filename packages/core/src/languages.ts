/** Supported interface locales. Native names remain readable before a language is selected. */
export const supportedLanguages = [
  {code: 'en', label: 'English'},
  {code: 'zh-CN', label: '简体中文'},
  {code: 'zh-TW', label: '繁體中文'},
  {code: 'ja', label: '日本語'},
  {code: 'ko', label: '한국어'},
  {code: 'de', label: 'Deutsch'},
  {code: 'fr', label: 'Français'},
  {code: 'es', label: 'Español'},
  {code: 'pt', label: 'Português'},
  {code: 'ru', label: 'Русский'},
] as const;
export type AppLanguage = typeof supportedLanguages[number]['code'];
export type BaseLanguage = 'zh-CN' | 'en';
/** Older feature-specific copy has two languages; other locales receive English. */
export const legacyLanguage = (language: AppLanguage): BaseLanguage => language === 'zh-CN' ? 'zh-CN' : 'en';
export type LanguagePreference = AppLanguage | 'system';
export interface SystemLanguage { locales: string[]; installerLanguage?: string | null; }
export interface ResolvedLanguageSettings { language: AppLanguage; languagePreference: LanguagePreference; }
export const isAppLanguage = (value: unknown): value is AppLanguage =>
  typeof value === 'string' && supportedLanguages.some(item => item.code === value);

/** Accept BCP47 and POSIX locales. Unsupported/C locales always use English. */
export function matchAppLanguage(locale: string | null | undefined): AppLanguage {
  const tag = ((locale ?? '').trim().split(/[.@]/)[0] ?? '').replace(/_/g, '-').toLowerCase();
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(tag)) return 'en';
  const [base, ...parts] = tag.split('-');
  if (base === 'zh') {
    if (parts.includes('hant')) return 'zh-TW';
    if (parts.includes('hans')) return 'zh-CN';
    return parts.some(part => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-TW' : 'zh-CN';
  }
  return isAppLanguage(base) ? base : 'en';
}

/** An old saved language represents an explicit choice, never a system default. */
export function resolveLanguageSettings(
  saved: unknown,
  locales: readonly string[],
  installerLanguage?: string | null,
): ResolvedLanguageSettings {
  const previous = saved && typeof saved === 'object' && !Array.isArray(saved)
    ? saved as Record<string, unknown> : null;
  const primary = locales.find(locale => typeof locale === 'string' && locale.trim()) ?? '';
  const system = matchAppLanguage(primary);
  if (previous?.languagePreference === 'system') return {language: system, languagePreference: 'system'};
  if (isAppLanguage(previous?.languagePreference)) {
    return {language: previous.languagePreference, languagePreference: previous.languagePreference};
  }
  if (isAppLanguage(previous?.language)) {
    return {language: previous.language, languagePreference: previous.language};
  }
  if (!previous && isAppLanguage(installerLanguage)) {
    return {language: installerLanguage, languagePreference: installerLanguage === system ? 'system' : installerLanguage};
  }
  return {language: system, languagePreference: 'system'};
}
