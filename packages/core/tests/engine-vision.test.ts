import { describe, expect, it } from 'vitest';
import {
  VISION_READER_BASENAMES,
  detectedHasVisionReader,
  engineAllowsImageInput,
  engineHasVisionReader,
  engineVisionTextOnly,
  engineVisionUnavailableTitle,
  isVisionReaderName,
  visionReaderOfInstall,
} from '../src/engine-vision';

describe('engine vision reader detection', () => {
  it('recognizes official reader names and ignores the main engine binary', () => {
    expect(VISION_READER_BASENAMES).toContain('strata-vision');
    for (const name of [
      'strata-vision',
      'strata-vision.exe',
      'STRATA-VISION.EXE',
      String.raw`D:\Strata\engine\strata-vision-hip.exe`,
      '/opt/strata/engine/strata-vision-hip',
    ]) {
      expect(isVisionReaderName(name), name).toBe(true);
    }
    for (const name of ['strata', 'strata.exe', 'strata-sycl.sh', 'BUILD.json']) {
      expect(isVisionReaderName(name), name).toBe(false);
    }
  });

  it('treats a SYCL-style file list as text-only and a CUDA/HIP list as having a reader', () => {
    const sycl = ['BUILD.json', 'strata', 'libpi_level_zero.so', 'engine-component.json'];
    const cuda = ['BUILD.json', 'strata', 'strata-vision', 'libcublas.so.13'];
    const hip = ['BUILD.json', 'strata.exe', 'strata-vision-hip.exe'];
    expect(engineHasVisionReader(sycl)).toBe(false);
    expect(engineHasVisionReader(cuda)).toBe(true);
    expect(engineHasVisionReader(hip)).toBe(true);
  });

  it('does not default-enable image input without a reader, and leaves DeepSeek and vision packages alone', () => {
    expect(engineAllowsImageInput(true, false)).toBe(false);
    expect(engineAllowsImageInput(true, true)).toBe(true);
    expect(engineAllowsImageInput(true, undefined)).toBe(true);
    expect(engineAllowsImageInput(false, true)).toBe(false);
    expect(engineAllowsImageInput(true, false, { deepseek: true })).toBe(true);
    expect(engineAllowsImageInput(false, false, { deepseek: true })).toBe(false);
  });

  it('looks up a detected runtime and treats a missing record as unchanged', () => {
    expect(detectedHasVisionReader({ hasVisionReader: false })).toBe(false);
    expect(detectedHasVisionReader({ hasVisionReader: true })).toBe(true);
    expect(detectedHasVisionReader({})).toBe(true);
    expect(detectedHasVisionReader(undefined)).toBe(true);
    const runtimes = [
      { installDir: '/sycl', hasVisionReader: false },
      { installDir: '/cuda', hasVisionReader: true },
    ];
    expect(visionReaderOfInstall('/sycl', runtimes)).toBe(false);
    expect(visionReaderOfInstall('/cuda', runtimes)).toBe(true);
    expect(visionReaderOfInstall('/missing', runtimes)).toBe(true);
    expect(visionReaderOfInstall(undefined, runtimes)).toBe(true);
  });

  it('explains text-only support in Chinese and English', () => {
    expect(engineVisionUnavailableTitle('zh-CN')).toBe('无法使用图像输入');
    expect(engineVisionUnavailableTitle('en')).toBe('Image input is unavailable');
    expect(engineVisionTextOnly('zh-CN')).toContain('只能处理文字');
    expect(engineVisionTextOnly('zh-CN')).toContain('strata-vision');
    expect(engineVisionTextOnly('en')).toMatch(/only text is supported/i);
    expect(engineVisionTextOnly('en')).toContain('strata-vision');
    expect(engineVisionTextOnly('zh-TW')).toBe(engineVisionTextOnly('zh-CN'));
    expect(engineVisionTextOnly('ja')).toBe(engineVisionTextOnly('en'));
  });
});
