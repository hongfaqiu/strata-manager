import type { ModelDownloadRequest } from './model-download';
import type { OrcaImportRequest } from './orca-import';

/**
 * 「使用已有模型」(#75): reuse GGUF files already on disk, like upstream
 * `START-HERE.bat --family F --model Q --gguf-dir DIR`. The native side scans read-only
 * (scan_local_models); setup then runs with `--gguf-dir` (and `--data-dir` for an existing MTP layer).
 *
 * Upstream setup.py has no `--mtp` setup flag: an existing MTP draft layer is found at
 * `<data folder>/mtp/rt/experts.bin`, so a chosen MTP folder maps to `--data-dir`. The ORCA.md
 * import writes its own config and passes it to the engine as `--mtp`.
 */
export interface LocalModelRequest { ggufDirectory: string; mtpPath?: string }
export type LocalShardState = 'ok' | 'missing' | 'unreadable' | 'notGguf' | 'tooSmall';
export interface LocalShard {
  name: string; bytes: number;
  /** tooSmall: shorter than its own GGUF header's tensor directory says (not a size floor: a metadata-only first split is ~10 MB). */
  state: LocalShardState;
  /** The length the shard's GGUF header needs, when readable. */
  expectedBytes?: number | null;
  /** An unfinished download beside it (.part, .incomplete, HF --local-dir cache). */
  partialDownload?: string | null;
}
export type LocalModelKind = 'official' | 'renamed' | 'orca' | 'unsupported' | 'unknown';
export interface LocalGgufGroup {
  id: string; name: string; firstShard: string; quant: string | null; kind: LocalModelKind; family: string | null;
  shards: LocalShard[]; totalBytes: number; complete: boolean; installable: boolean; warnings: string[]; problems: string[];
}
export interface LocalModelScan { directory: string; selectedFile: string | null; groups: LocalGgufGroup[]; problems: string[] }
export interface MtpCheck { input: string; rtDirectory: string | null; dataDirectory: string | null; expertsBytes: number; problems: string[] }

/** One model (file name without the quant) with its quantizations, for the 「量化版本」 choice. */
export interface LocalGgufChoice { model: string; variants: LocalGgufGroup[] }

/** `Qwen3.8-Flash-Next-UD-Q4_K_XL` → `Qwen3.8-Flash-Next`; names without a quant stay as they are. */
export function localModelBaseName(group: Pick<LocalGgufGroup, 'name' | 'quant'>): string {
  if (!group.quant) return group.name;
  const index = group.name.toUpperCase().lastIndexOf(group.quant.toUpperCase());
  if (index < 0) return group.name;
  const base = `${group.name.slice(0, index)}${group.name.slice(index + group.quant.length)}`.replace(/[-_. ]+$/, '').replace(/^[-_. ]+/, '').replace(/[-_.]{2,}/g, '-');
  return base || group.name;
}

/** Group scan results by model, installable variants first; order inside a model follows the scan. */
export function groupLocalGgufs(scan: Pick<LocalModelScan, 'groups'> | undefined): LocalGgufChoice[] {
  const choices: LocalGgufChoice[] = [];
  for (const group of scan?.groups ?? []) {
    const model = localModelBaseName(group);
    const found = choices.find(choice => choice.model === model);
    if (found) found.variants.push(group); else choices.push({ model, variants: [group] });
  }
  for (const choice of choices) choice.variants.sort((a, b) => Number(b.installable) - Number(a.installable));
  return choices.sort((a, b) => Number(b.variants.some(v => v.installable)) - Number(a.variants.some(v => v.installable)));
}

/** First installable group; the user can still pick another variant. */
export function defaultLocalGgufGroup(scan: LocalModelScan | undefined): LocalGgufGroup | undefined {
  return groupLocalGgufs(scan).flatMap(choice => choice.variants).find(group => group.installable);
}

export type LocalModelAction = 'setup' | 'orca' | 'blocked';
export function localModelAction(group: LocalGgufGroup | undefined): LocalModelAction {
  if (!group?.installable) return 'blocked';
  if (group.kind === 'orca') return 'orca';
  return group.family && group.quant ? 'setup' : 'blocked';
}

const quoted = (value: string) => /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;

/**
 * The equivalent upstream command, shown so the user can see exactly what runs.
 * `windows` selects START-HERE.bat; otherwise `python setup.py`.
 */
export function localModelCommand(group: LocalGgufGroup, request: LocalModelRequest, mtp: MtpCheck | undefined, context: number, windows: boolean): string {
  const launcher = windows ? 'START-HERE.bat' : 'python setup.py';
  if (localModelAction(group) === 'orca') {
    // ORCA.md: tools/convert_to_bf16.py --compat-bf16 + a hand-written config; there is no setup.py flag for it.
    return `ORCA.md: python tools/convert_to_bf16.py --compat-bf16 … → strata-orca-iq3_xxs.json${mtp?.rtDirectory ? ` (--mtp ${quoted(mtp.rtDirectory)})` : ''}`;
  }
  const parts = [launcher, '--family', group.family ?? '?', '--model', group.quant ?? '?', '--gguf-dir', quoted(request.ggufDirectory), '--context', String(context)];
  if (mtp?.dataDirectory) parts.push('--data-dir', quoted(mtp.dataDirectory));
  return parts.join(' ');
}

/** The run_setup request for an installable official/renamed group. */
export function localSetupRequest(base: ModelDownloadRequest, group: LocalGgufGroup, request: LocalModelRequest): ModelDownloadRequest & { localModel: LocalModelRequest } {
  if (localModelAction(group) !== 'setup') throw new Error('所选模型文件不能用官方安装器准备 / The selected files cannot be prepared by the official installer');
  if (base.model !== group.family || base.quant !== group.quant) throw new Error('模型与量化版本不一致 / Model and quantization do not match');
  const ggufDirectory = request.ggufDirectory.trim();
  if (!ggufDirectory) throw new Error('请选择模型所在目录 / Choose the model folder');
  const mtpPath = request.mtpPath?.trim();
  return { ...base, localModel: { ggufDirectory, ...(mtpPath ? { mtpPath } : {}) } };
}

/** The ORCA.md import for local OrcaRouter IQ3_XXS shards, with an optional existing MTP layer. */
export function localOrcaRequest(group: LocalGgufGroup, request: LocalModelRequest, directorySeparator: string): OrcaImportRequest {
  if (localModelAction(group) !== 'orca') throw new Error('所选模型文件不是 OrcaRouter IQ3_XXS / The selected files are not OrcaRouter IQ3_XXS');
  const directory = request.ggufDirectory.trim().replace(/[\\/]+$/, '');
  const mtpPath = request.mtpPath?.trim();
  return { source: 'local', shardPath: `${directory}${directorySeparator}${group.firstShard}`, mtp: true, ...(mtpPath ? { mtpPath } : {}) };
}
