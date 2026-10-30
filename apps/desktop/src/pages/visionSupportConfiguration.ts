import type { JsonObject } from '@strata-manager/core';
import { applyDeepseek41Vision, applyStartupField, isDeepseek41Config, replaceStartupArgument, startupArgsOf, startupArgumentRows, validateStartupConfiguration, type StartupFieldSpec } from '@strata-manager/core';

export interface VisionSupportDraft {
  exe: string; model: string; mmproj: string; gpu: boolean; threads: string; maxTokens: string;
}
const visionFlag: StartupFieldSpec = { key: '--vision', target: 'arg', group: 'vision', kind: 'boolean', zh: '图像输入', en: 'Image input' };
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const path = (value: unknown) => typeof value === 'string' ? value : '';

export function visionDraftOf(config: JsonObject, installDir: string): VisionSupportDraft {
  if (config.vision != null && !object(config.vision)) throw new Error('vision 必须为对象 / vision must be an object');
  const vision = object(config.vision) ? config.vision : {};
  const args = startupArgsOf(config);
  const modelArg = (flag: string) => {
    const positions = args.flatMap((value, index) => value === flag ? [index] : []);
    const value = positions.length === 1 ? args[positions[0]! + 1] : undefined;
    return value && !value.startsWith('--') ? value : '';
  };
  const separator = installDir.includes('\\') && !installDir.includes('/') ? '\\' : '/';
  const directory = installDir.replace(/[\\/]+$/, '');
  // Prefer the same folder as run-config `exe` (engine_cuda12/, engine-cuda12/, …).
  const mainExe = path(config.exe);
  const engineDirFromExe = (() => {
    if (!mainExe) return '';
    const cut = Math.max(mainExe.lastIndexOf('/'), mainExe.lastIndexOf('\\'));
    return cut > 0 ? mainExe.slice(0, cut).replace(/[\\/]+$/, '') : '';
  })();
  const defaultVisionExe = engineDirFromExe
    ? `${engineDirFromExe}${separator}strata-vision.exe`
    : (directory ? `${directory}${separator}engine${separator}strata-vision.exe` : '');
  return {
    exe: path(vision.exe) || defaultVisionExe,
    model: path(vision.model) || modelArg('--model') || modelArg('--native'),
    mmproj: path(vision.mmproj), gpu: vision.gpu === true,
    threads: String(vision.threads ?? 8), maxTokens: String(vision.max_tokens ?? 1024),
  };
}

/** DeepSeek-V4.1-Flash reads pictures with its own engine: only `--vision on|off` changes, no vision section or files. */
export function configureDeepseek41VisionSupport(config: JsonObject, on: boolean): JsonObject {
  const next = applyDeepseek41Vision(config, on);
  validateStartupConfiguration(next);
  return next;
}

export function configureVisionSupport(config: JsonObject, draft: VisionSupportDraft): JsonObject {
  // The Qwen picture reader (vision section + bare --vision) would stop strata-dsv41; DeepSeek turns its own tower on.
  if (isDeepseek41Config(config)) return configureDeepseek41VisionSupport(config, true);
  if (config.vision != null && !object(config.vision)) throw new Error('vision 必须为对象 / vision must be an object');
  for (const key of ['exe', 'model', 'mmproj'] as const) if (!draft[key].trim()) throw new Error(`vision.${key}: 文件路径不能为空 / a file path is required`);
  let next = structuredClone(config);
  for (const key of ['exe', 'model', 'mmproj'] as const) next = applyStartupField(next, { key: `vision.${key}`, target: 'config', group: 'vision', kind: 'text', zh: key, en: key }, draft[key].trim());
  next = applyStartupField(next, { key: 'vision.gpu', target: 'config', group: 'vision', kind: 'boolean', zh: 'GPU', en: 'GPU' }, String(draft.gpu));
  next = applyStartupField(next, { key: 'vision.threads', target: 'config', group: 'vision', kind: 'integer', min: 1, max: 65535, zh: '线程', en: 'Threads' }, draft.threads);
  next = applyStartupField(next, { key: 'vision.max_tokens', target: 'config', group: 'vision', kind: 'integer', min: 1, max: 2147483647, zh: '图片 Token 上限', en: 'Image token limit' }, draft.maxTokens);
  // Work backwards so only duplicate zero-operand flags are removed; every other
  // argument retains its position and value, including unknown/custom options.
  const rows = startupArgumentRows(next).filter(row => row.tokens[0] === '--vision');
  for (const row of rows.slice(1).reverse()) next = replaceStartupArgument(next, row, []);
  if (!rows.length) next = applyStartupField(next, visionFlag, 'true');
  validateStartupConfiguration(next);
  return next;
}

export function assertVisionBaseline(baseline: JsonObject, current: JsonObject): void {
  if (JSON.stringify(current) !== JSON.stringify(baseline)) throw new Error('配置已被其他操作修改。请重新读取后再保存，避免覆盖新设置。 / Configuration changed since it was loaded. Reload before saving to preserve newer settings.');
}
