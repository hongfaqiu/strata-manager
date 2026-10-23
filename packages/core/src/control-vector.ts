import type { JsonObject } from './types';
import { startupArgsOf, startupArgumentRows } from './config-tuning';
import { engineFlagSupport } from './engine-flag-support';

/**
 * 控制向量（Control Vector）: Strata engine 0.1.44+ applies a llama.cpp-format control vector to the residual
 * stream (upstream src/program/generate.cpp `--control-vector-scaled` / `--control-vector-layer-range` /
 * `--cvec-mode` / `--cvec-dir`). The engine has no built-in vector: a FILE is always required. The upstream
 * release ships one in `data/experimental-speed-projection/` (setup.py `ESP_VECTOR`), and its setup writes the
 * preset below ("experimental speed projection"). A loaded vector is switched per request with
 * `"experimental_speed_projection": false` (serve/server.py `projection_key` → engine `cvec=0|1`).
 */
export const CONTROL_VECTOR_FLAGS = ['--control-vector', '--control-vector-scaled', '--control-vector-layer-range', '--cvec-mode', '--cvec-dir'] as const;
export const CONTROL_VECTOR_MIN_ENGINE = '0.1.44';
export const BUNDLED_CONTROL_VECTOR_DIR = ['data', 'experimental-speed-projection'] as const;
export const BUNDLED_CONTROL_VECTOR_FILE = 'Qwen3.8-Flash-Next-experimental-speed-projection.gguf';
/** The request field (OpenAI and Anthropic bodies) and the config default `sampling.experimental_speed_projection`. */
export const CONTROL_VECTOR_REQUEST_FIELD = 'experimental_speed_projection';

export type ControlVectorMode = 'project' | 'add';
export interface ControlVectorSettings {
  file: string;
  scale: string;
  /** Inclusive layer range; both empty = the engine default (1 .. the last layer). */
  first: string; last: string;
  mode: ControlVectorMode;
  /** 'per-layer' or 'single:L' (project mode only). */
  direction: string;
}
/** setup.py's profile for the bundled vector (`--experimental-speed-projection on`). */
export const CONTROL_VECTOR_PRESET: Omit<ControlVectorSettings, 'file'> = { scale: '1.0', first: '4', last: '44', mode: 'project', direction: 'per-layer' };
/** The engine's own defaults when a flag is absent (generate.cpp Options: add, 1 .. last, per-layer). */
export const CONTROL_VECTOR_ENGINE_DEFAULTS = { mode: 'add' as ControlVectorMode, direction: 'per-layer' };

export interface ControlVectorState {
  enabled: boolean;
  settings: ControlVectorSettings;
  /** Several vectors (a comma list or repeated flags): edit them in the full argument list. */
  multiple: boolean;
}

const sepOf = (path: string) => (path.includes('\\') || /^[A-Za-z]:/.test(path) ? '\\' : '/');
/** `<Strata>\data\experimental-speed-projection\…gguf` from the config's `cwd` (setup.py writes cwd = the Strata root). */
export function bundledControlVectorPath(root: string | undefined | null): string | null {
  const base = (root ?? '').trim().replace(/[\\/]+$/, '');
  if (!base) return null;
  const sep = sepOf(base);
  return [base, ...BUNDLED_CONTROL_VECTOR_DIR, BUNDLED_CONTROL_VECTOR_FILE].join(sep);
}
export function isBundledControlVector(file: string): boolean {
  return file.trim().replace(/\\/g, '/').toLowerCase().endsWith(`/${BUNDLED_CONTROL_VECTOR_DIR.join('/')}/${BUNDLED_CONTROL_VECTOR_FILE}`.toLowerCase());
}

/** FILE:SCALE as the engine splits it (the last ':'; a Windows drive letter is not a scale). */
export function splitScaledVector(item: string): { file: string; scale: string } {
  const colon = item.lastIndexOf(':');
  if (colon > 1 && colon < item.length - 1 && Number.isFinite(Number(item.slice(colon + 1)))) return { file: item.slice(0, colon), scale: item.slice(colon + 1) };
  return { file: item, scale: '1.0' };
}
export function formatScale(value: number): string { return Number.isInteger(value) ? value.toFixed(1) : String(value); }

export function readControlVector(config: JsonObject): ControlVectorState {
  const rows = startupArgumentRows(config);
  const pick = (flag: string) => rows.filter(row => row.tokens[0] === flag);
  const scaled = pick('--control-vector-scaled'); const plain = pick('--control-vector');
  const items = [...plain.map(row => ({ file: row.tokens[1] ?? '', scale: '1.0' })), ...scaled.flatMap(row => (row.tokens[1] ?? '').split(',').filter(Boolean).map(splitScaledVector))];
  const range = pick('--control-vector-layer-range')[0];
  const mode = pick('--cvec-mode')[0]?.tokens[1];
  const direction = pick('--cvec-dir')[0]?.tokens[1];
  const first = items[0];
  return {
    enabled: items.length > 0,
    multiple: items.length > 1,
    settings: {
      file: first?.file ?? '', scale: first?.scale ?? CONTROL_VECTOR_PRESET.scale,
      first: range?.tokens[1] ?? '', last: range?.tokens[2] ?? '',
      mode: mode === 'project' ? 'project' : mode === 'add' ? 'add' : CONTROL_VECTOR_ENGINE_DEFAULTS.mode,
      direction: direction ?? CONTROL_VECTOR_ENGINE_DEFAULTS.direction,
    },
  };
}

/** The first problem with these settings (zh / en), or null. `maxLayer`: the vector's highest `direction.<l>`. */
export function controlVectorError(settings: ControlVectorSettings, maxLayer?: number | null): string | null {
  if (!settings.file.trim()) return '请选择控制向量文件 / choose a control vector file';
  if (settings.file.includes(',')) return '文件路径不能包含逗号（引擎用逗号分隔多个向量） / the path cannot contain a comma';
  const scale = Number(settings.scale);
  if (!settings.scale.trim() || !Number.isFinite(scale)) return '强度必须是数字，例如 1.0 / strength must be a number such as 1.0';
  const first = settings.first.trim(), last = settings.last.trim();
  if (!!first !== !!last) return '层范围需要同时填写起止层，或都留空 / fill both layer range ends or leave both empty';
  if (first) {
    const a = Number(first), b = Number(last);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) return '层范围必须是从 1 开始的整数 / layers are whole numbers from 1';
    if (a > b) return '起始层不能大于结束层 / the first layer is after the last';
    if (maxLayer != null && a > maxLayer) return `起始层超出向量的层数（最高 ${maxLayer}） / the first layer is past the vector's last layer (${maxLayer})`;
  }
  if (settings.mode !== 'project' && settings.mode !== 'add') return '模式只能是 project 或 add / mode is project or add';
  if (settings.direction !== 'per-layer') {
    const single = /^single:(\d+)$/.exec(settings.direction);
    if (!single || Number(single[1]) < 1) return '方向只能是 per-layer 或 single:层号 / direction is per-layer or single:L';
    if (settings.mode !== 'project') return 'single:L 只用于 project 模式 / single:L needs project mode';
    if (maxLayer != null && Number(single[1]) > maxLayer) return `single:${single[1]} 超出向量的层数（最高 ${maxLayer}） / past the vector's last layer`;
  }
  return null;
}

/** The engine args for `settings` (scale written like setup.py: 1 → "1.0"). */
export function controlVectorArgs(settings: ControlVectorSettings): string[] {
  const scale = formatScale(Number(settings.scale));
  return [
    '--control-vector-scaled', `${settings.file.trim()}:${scale}`,
    ...(settings.first.trim() ? ['--control-vector-layer-range', String(Number(settings.first)), String(Number(settings.last))] : []),
    '--cvec-mode', settings.mode,
    '--cvec-dir', settings.direction,
  ];
}

/** Replace every control-vector flag with `settings` (null = off: the flags are removed, all other args stay in order). */
export function applyControlVector(config: JsonObject, settings: ControlVectorSettings | null): JsonObject {
  if (settings) { const error = controlVectorError(settings); if (error) throw new Error(error); }
  const rows = startupArgumentRows(config);
  const drop = new Set<number>();
  for (const row of rows) if ((CONTROL_VECTOR_FLAGS as readonly string[]).includes(row.tokens[0]!)) for (let i = 0; i < row.tokens.length; i++) drop.add(row.offset + i);
  const args = startupArgsOf(config).filter((_, index) => !drop.has(index));
  return { ...structuredClone(config), args: settings ? [...args, ...controlVectorArgs(settings)] : args };
}

export interface ControlVectorAvailability { available: boolean; reason?: { zh: string; en: string } }
/** Disabled when the engine's --help was read and lacks the flag, or on a Mac (upstream docs/MAC.md: not ported). */
export function controlVectorAvailability(engineFlags: readonly string[] | null | undefined, mac: boolean): ControlVectorAvailability {
  if (mac) return { available: false, reason: { zh: 'Mac 版 Strata 引擎还没有移植控制向量（上游 docs/MAC.md）。', en: 'The Mac engine has not ported control vectors yet (upstream docs/MAC.md).' } };
  if (engineFlagSupport('--control-vector-scaled', engineFlags) === 'unlisted') return { available: false, reason: { zh: `当前引擎的 --help 没有 --control-vector-scaled，需要 Strata 引擎 ${CONTROL_VECTOR_MIN_ENGINE} 及以上。`, en: `The installed engine's --help has no --control-vector-scaled; it needs Strata engine ${CONTROL_VECTOR_MIN_ENGINE} or newer.` } };
  return { available: true };
}

export type ControlVectorCheckStatus = 'ok' | 'missing' | 'unreadable' | 'notGguf' | 'notControlVector' | 'short' | 'empty';
export interface ControlVectorCheck { path: string; status: ControlVectorCheckStatus; bytes?: number | null; architecture?: string | null; layers: number; maxLayer?: number | null; detail?: string | null }
export function controlVectorCheckMessage(check: ControlVectorCheck, zh: boolean): string | null {
  const text: Record<ControlVectorCheckStatus, [string, string] | null> = {
    ok: null,
    missing: ['找不到这个文件。', 'File not found.'],
    unreadable: [`无法读取这个文件${check.detail ? `：${check.detail}` : ''}。`, `Cannot read the file${check.detail ? `: ${check.detail}` : ''}.`],
    notGguf: ['不是 GGUF 文件（文件头不是 GGUF）。', 'Not a GGUF file (no GGUF header).'],
    notControlVector: [`这是 GGUF，但不是控制向量（general.architecture 是 ${check.architecture ?? '空'}，应为 controlvector）。模型权重文件不能用在这里。`, `A GGUF, but not a control vector (general.architecture is ${check.architecture ?? 'empty'}, expected controlvector). Model weights do not go here.`],
    short: ['文件不完整，比文件头记录的长度短。', 'The file is incomplete: shorter than its header says.'],
    empty: ['控制向量里没有任何 direction.<层号> 数据。', 'The control vector has no direction.<layer> data.'],
  };
  const entry = text[check.status];
  return entry ? (zh ? entry[0] : entry[1]) : null;
}
