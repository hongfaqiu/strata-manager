import { describe, expect, it } from 'vitest';
import { supportedLanguages } from '../src/languages';
import { macVisionText, shortMacVersion } from '../../../apps/desktop/src/pages/macVisionStrings';

describe('macOS image-input notice', () => {
  it('has short copy in every app language with the version filled in', () => {
    for (const { code } of supportedLanguages) {
      const title = macVisionText(code, 'mvTitle', '27');
      expect(title).toContain('27');
      expect(title).not.toContain('{v}');
      for (const key of ['mvBody', 'mvThisMac', 'mvNeeded'] as const) expect(macVisionText(code, key).length).toBeGreaterThan(0);
      expect(macVisionText(code, 'mvBody').length).toBeLessThanOrEqual(90);
    }
    expect(macVisionText('en', 'mvTitle', shortMacVersion('27.0'))).toBe('Image input needs macOS 27+');
    expect(shortMacVersion('26.1')).toBe('26.1');
  });
});
