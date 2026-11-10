import type { AppLanguage } from './languages';
import type { DetectedRuntime } from './installation-types';

/** Official picture-reader file names an engine package may ship. */
export const VISION_READER_BASENAMES = [
  'strata-vision',
  'strata-vision.exe',
  'strata-vision-hip',
  'strata-vision-hip.exe',
] as const;

/** Whether `name` (a path or a basename) is an official picture-reader binary. */
export function isVisionReaderName(name: string): boolean {
  const base = name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return (VISION_READER_BASENAMES as readonly string[]).includes(base);
}

/** Whether a list of engine-package file names includes a picture reader. */
export function engineHasVisionReader(names: readonly string[]): boolean {
  return names.some(isVisionReaderName);
}

/**
 * Whether the UI may offer image input that needs `strata-vision`.
 * DeepSeek uses its own engine tower, so a missing `strata-vision` does not block it.
 * An unknown / omitted reader flag stays allowed so older payloads are unchanged.
 */
export function engineAllowsImageInput(
  modelAllowsImages: boolean,
  hasVisionReader?: boolean,
  options?: { deepseek?: boolean },
): boolean {
  if (!modelAllowsImages) return false;
  if (options?.deepseek) return true;
  return hasVisionReader !== false;
}

/** Whether a detected runtime's engine package includes a picture reader. */
export function detectedHasVisionReader(
  runtime?: Pick<DetectedRuntime, 'hasVisionReader'> | null,
): boolean {
  return runtime?.hasVisionReader !== false;
}

/** Look up the installed engine package for `installDir` among detected runtimes. */
export function visionReaderOfInstall(
  installDir: string | undefined,
  detected?: readonly Pick<DetectedRuntime, 'installDir' | 'hasVisionReader'>[] | null,
): boolean {
  if (!installDir || !detected?.length) return true;
  const hit = detected.find(item => item.installDir === installDir);
  return hit ? hit.hasVisionReader !== false : true;
}

/** Short bilingual note when the engine package has no picture reader. */
export function engineVisionTextOnly(language: AppLanguage): string {
  return language === 'zh-CN' || language === 'zh-TW'
    ? '当前引擎包没有读图组件（strata-vision），只能处理文字。'
    : 'This engine package has no picture reader (strata-vision), so only text is supported.';
}

/** Title for the image-settings banner when the package has no reader. */
export function engineVisionUnavailableTitle(language: AppLanguage): string {
  return language === 'zh-CN' || language === 'zh-TW'
    ? '无法使用图像输入'
    : 'Image input is unavailable';
}
