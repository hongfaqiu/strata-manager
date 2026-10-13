import { describe, expect, it } from 'vitest';
import { matchAppLanguage, resolveLanguageSettings, supportedLanguages } from '../src/languages';

describe('system language', () => {
  it.each([
    ['zh_CN.UTF-8', 'zh-CN'], ['zh-Hans-SG', 'zh-CN'], ['zh-Hant', 'zh-TW'],
    ['zh_TW.UTF-8', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'],
    ['en_US.UTF-8', 'en'], ['ja-JP', 'ja'], ['ko_KR.UTF-8', 'ko'],
    ['de-DE', 'de'], ['fr_CA.UTF-8', 'fr'], ['es-MX', 'es'], ['pt-BR', 'pt'],
    ['ru_RU.UTF-8', 'ru'], ['C.UTF-8', 'en'], ['POSIX', 'en'], ['ar-SA', 'en'], ['', 'en'],
    ['zh_CN?', 'en'], ['de--DE', 'en'], ['zh-<invalid>', 'en'],
  ])('matches %s to %s', (locale, expected) => expect(matchAppLanguage(locale)).toBe(expected));

  it('keeps unsupported primary locale English instead of taking a Chinese secondary', () => {
    expect(resolveLanguageSettings(null, ['ar-SA', 'zh-CN'])).toEqual({ language: 'en', languagePreference: 'system' });
  });
  it('detects the computer language for a clean installation', () => {
    expect(resolveLanguageSettings(null, ['ja-JP'])).toEqual({ language: 'ja', languagePreference: 'system' });
  });
  it('applies an explicit installer choice only when app settings are new', () => {
    expect(resolveLanguageSettings(null, ['en-US'], 'fr')).toEqual({ language: 'fr', languagePreference: 'fr' });
    expect(resolveLanguageSettings({language: 'zh-CN'}, ['en-US'], 'fr')).toEqual({ language: 'zh-CN', languagePreference: 'zh-CN' });
  });
  it('keeps following the computer when the installer selected its system default', () => {
    expect(resolveLanguageSettings(null, ['de-DE'], 'de')).toEqual({ language: 'de', languagePreference: 'system' });
  });
  it('keeps legacy explicit choices when the computer language changes', () => {
    expect(resolveLanguageSettings({language: 'en'}, ['zh-CN'])).toEqual({ language: 'en', languagePreference: 'en' });
    expect(resolveLanguageSettings({language: 'zh-CN'}, ['en-US'])).toEqual({ language: 'zh-CN', languagePreference: 'zh-CN' });
  });
  it('follows system preferences on each launch and preserves manual overrides', () => {
    expect(resolveLanguageSettings({language: 'zh-CN', languagePreference: 'system'}, ['de-DE'])).toEqual({ language: 'de', languagePreference: 'system' });
    expect(resolveLanguageSettings({language: 'en', languagePreference: 'ko'}, ['de-DE'])).toEqual({ language: 'ko', languagePreference: 'ko' });
  });
  it('ignores malformed preferences and never returns unsupported locales', () => {
    expect(resolveLanguageSettings({language: 'ar', languagePreference: 42}, ['en-US'])).toEqual({ language: 'en', languagePreference: 'system' });
    expect(resolveLanguageSettings({language: 'en', languagePreference: '__proto__'}, ['ja-JP'])).toEqual({ language: 'en', languagePreference: 'en' });
  });
  it('supports ten distinct selectable locales', () => {
    expect(supportedLanguages).toHaveLength(10);
    expect(new Set(supportedLanguages.map(item=>item.code)).size).toBe(10);
  });
});
