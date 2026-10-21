/**
 * Community (third-party) model entries for the 「选择模型」 list: the built-in, pinned entries plus the
 * ones discovered from the Hugging Face API. Community entries are never the default recommendation.
 *
 * Built-in sizes and SHA-256 are the Hugging Face LFS values at the pinned revisions (API, 2026-10-21).
 * Everything here is pure (no IO) so it stays testable; the native `hf_models_api` call and the store
 * cache live in community-discovery.ts.
 */
import { MODEL_CATALOG } from './catalog';
import { macCatalogFamilyAllowed } from './local-runtime-package';
import type { RuntimePackagePlatform } from './local-runtime-package';

/** setup.py MODELS / local_model.rs SUPPORTED_QUANTS: the quantizations the engine has kernels for. */
export const SUPPORTED_QUANTS = ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S', 'IQ1_M', 'UD-IQ4_XS', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL', 'Q8_0'] as const;
/** local_model.rs setup_supports: (family, quant) pairs the official installer accepts. */
export const SETUP_FAMILY_QUANTS: Record<string, readonly string[]> = {
  qwen: ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'],
  swift: ['IQ2_XS', 'IQ3_XXS', 'IQ3_S'],
  coder: ['IQ1_M'],
  unsloth: ['UD-IQ4_XS', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL', 'Q8_0'],
  qwen36: ['UD-Q4_K_XL', 'UD-Q6_K_XL', 'Q8_0'],
};
export const setupSupports = (family: string, quant: string) => !!SETUP_FAMILY_QUANTS[family]?.includes(quant);

export interface CommunityFile { path: string; size: number; sha256?: string }
export interface CommunityQuant { files: CommunityFile[]; downloadGB: number; ramGB: number }
/** gsq-rco: weights baked; control-vector: official weights + a refusal-direction vector; orca: ORCA.md import. */
export type CommunityKind = 'gsq-rco' | 'control-vector' | 'orca';
export type CommunityRisk = 'mtpNotAbliterated' | 'agentPersistence' | 'noGuardrails' | 'unverified' | 'textOnly' | 'orcaRam' | 'controlVectorMac';
export type CommunityMacBlock = 'macGemv' | 'macControlVector' | 'macFamily';
export interface CommunityModel {
  id: string;
  /** Lowercase [a-z0-9-] slug; the registered config is community-<slug>-<quant>. */
  slug: string;
  name: string;
  repo: string;
  revision: string;
  /** setup.py --family the files are installed as. */
  family: string;
  kind: CommunityKind;
  images: boolean;
  quants: string[];
  quantInfo: Record<string, CommunityQuant>;
  mmproj?: CommunityFile;
  controlVector?: CommunityFile;
  risks: CommunityRisk[];
  /** Why the entry cannot be used on a Mac (Metal engine); undefined = usable. */
  macBlock?: CommunityMacBlock;
  /** Upstream evidence for the Mac note. */
  macBlockSource?: string;
  source: 'builtin' | 'discovered';
  downloads?: number;
  likes?: number;
  updatedAt?: string;
}

const GB = 1e9;
const gb = (bytes: number) => Math.round(bytes / GB * 10) / 10;
const officialRam = (family: string, quant: string) => MODEL_CATALOG.find(m => m.family === family)?.quantInfo[quant]?.ramGB;
const quantEntry = (files: CommunityFile[], family: string, quant: string): CommunityQuant => {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, downloadGB: gb(bytes), ramGB: officialRam(family, quant) ?? Math.ceil(files[0]!.size / GB + 10) };
};
/** The n-gram table shard 2 is byte-identical across GSQ-RCO sizes (and to ISTA-DASLab's). */
const NGRAM = { size: 28_800_138_432, sha256: '316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113' };
const sc117 = (quant: string, size: number, sha256: string) => quantEntry([
  { path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-${quant}-00001-of-00002.gguf`, size, sha256 },
  { path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-${quant}-00002-of-00002.gguf`, ...NGRAM },
], 'qwen', quant);
const alesha = (quant: string, size: number, sha256: string) => quantEntry([
  { path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-${quant}-00001-of-00002.gguf`, size, sha256 },
  { path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-${quant}-00002-of-00002.gguf`, ...NGRAM },
], 'qwen', quant);

export const UPSTREAM_GEMV_SOURCE = 'https://github.com/Niko1221/Strata/pull/2931';
/** MAC.md: the app offers Q2_0 / IQ3_XXS / IQ3_S; Unsloth's many-shard files need ./setup.sh's repack for now. */
export const UPSTREAM_MAC_APP_SOURCE = 'https://github.com/Niko1221/Strata/blob/main/docs/MAC.md#the-desktop-app-and-strata-launch-on-a-mac';
export const UPSTREAM_MAC_LIMITS_SOURCE = 'https://github.com/Niko1221/Strata/blob/main/docs/MAC.md#limits-this-version';

export const BUILTIN_COMMUNITY_MODELS: CommunityModel[] = [
  {
    id: 'sc117-abliterated', slug: 'sc117-abliterated', name: 'SC117 abliterated', repo: 'SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF',
    revision: 'eec4e10a2c29b440a2ae85591fa11569ce752963', family: 'qwen', kind: 'gsq-rco', images: true,
    quants: ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'],
    quantInfo: {
      Q2_0: sc117('Q2_0', 38_021_379_872, '1620faf21c845524cbe38dcbbaf850b8d155c2299df05d8b7bfb43b642c4647e'),
      IQ2_XS: sc117('IQ2_XS', 39_665_015_072, '4acc3ebb5050d20117bdc77fc39200e709dfe2b2367f3522c95b9112a30aff81'),
      IQ3_XXS: sc117('IQ3_XXS', 47_342_144_896, '03b11926b41a3d7f7a008882b1bc7a6330a3c9c43d3cad4598d31dc73042fdc5'),
      IQ3_S: sc117('IQ3_S', 55_063_448_064, '40f369eca301ec6ea318dbb671b3132c26a2f0b89aa5458a7051b33215ee296c'),
    },
    mmproj: { path: 'mmproj-Qwen3.8-Flash-Next-BF16.gguf', size: 907_542_944, sha256: '2e788f8c511d8093c7b43cb87b2fd7e14228340318057f8fb20c86df2efe2355' },
    risks: ['noGuardrails', 'mtpNotAbliterated', 'agentPersistence'], source: 'builtin', downloads: 1_950_149, likes: 332,
  },
  {
    id: 'alesha-pro-cvec', slug: 'alesha-pro-cvec', name: 'alesha-pro refusal vector', repo: 'alesha-pro/Qwen3.8-Flash-Next-abliterated-GSQ-RCO-Strata-GGUF',
    revision: 'd4af3be5701549435e0770d625f79dd2def1358f', family: 'qwen', kind: 'control-vector', images: true,
    quants: ['Q2_0', 'IQ2_XS', 'IQ3_XXS', 'IQ3_S'],
    quantInfo: {
      Q2_0: alesha('Q2_0', 37_623_740_192, '69820c02ec7d0b45ef2ebb19d6620299db749fe2aded7f39f93c6b88b199b720'),
      IQ2_XS: alesha('IQ2_XS', 39_225_954_592, '92cee27ae5bbadcd732416a0f7a7f0acc092399dbbe8f5a5efa707c2ec0a49d7'),
      IQ3_XXS: alesha('IQ3_XXS', 47_039_860_096, '219ea929900dfa9ef091f3aa473fdba6874b65fcb36526d7d851ac9e95856d15'),
      IQ3_S: alesha('IQ3_S', 54_817_524_224, '4c1eb2ceb4915e1192f4f386021897bde56a97f40a0bb78bb86465e0f7d2aca3'),
    },
    mmproj: { path: 'mmproj-Qwen3.8-Flash-Next-BF16.gguf', size: 907_543_008, sha256: 'b1a82259702816a5330d7bd7607cd9676b11780e79ff7348c21103ff3ce49bd0' },
    controlVector: { path: 'Huihui-Qwen3.8-Flash-Next-refusal-direction-r.gguf', size: 483_520, sha256: '59f9ae8b4372107ae79044278a4406bdfe8f8861fe599aa5848515f0d072be38' },
    risks: ['noGuardrails', 'controlVectorMac'], macBlock: 'macControlVector', macBlockSource: UPSTREAM_MAC_LIMITS_SOURCE,
    source: 'builtin', downloads: 207_818, likes: 164,
  },
  {
    id: 'orcarouter-iq3xxs', slug: 'orcarouter', name: 'OrcaRouter Uncensored', repo: 'orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF',
    revision: 'd366e279688c1f2fd6e75e2f98475d38db534f1d', family: 'orca', kind: 'orca', images: false,
    quants: ['IQ3_XXS'],
    quantInfo: { IQ3_XXS: { files: [
      { path: 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf', size: 44_637_691_008 },
      { path: 'Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf', size: 40_564_977_024 },
    ], downloadGB: 85.2, ramGB: 54 } },
    risks: ['noGuardrails', 'textOnly', 'orcaRam'], macBlock: 'macGemv', macBlockSource: UPSTREAM_GEMV_SOURCE,
    source: 'builtin', downloads: 869_081, likes: 1002,
  },
];

export const isCommunityFamily = (family: string) => family.startsWith('community:');
export const communityFamily = (id: string) => `community:${id}`;
export const communityIdOf = (family: string) => isCommunityFamily(family) ? family.slice('community:'.length) : undefined;
export const communityModelName = (slug: string, quant: string) => `community-${slug}-${quant.toLowerCase()}`;

export interface CommunityAvailability { downloadable: boolean; reason?: CommunityMacBlock | 'orcaImport' }
/** Mac (Metal engine) blocks and the ORCA.md entry (imported, not downloaded through this list). */
export function communityAvailability(model: CommunityModel, platform: RuntimePackagePlatform): CommunityAvailability {
  if (platform === 'macos') {
    if (model.macBlock) return { downloadable: false, reason: model.macBlock };
    if (!macCatalogFamilyAllowed(model.family)) return { downloadable: false, reason: 'macFamily' };
  }
  if (model.kind === 'orca') return { downloadable: false, reason: 'orcaImport' };
  return { downloadable: true };
}

/** strata_control/mac_fit.py MAC_MODELS: the sizes upstream lists for a Mac (Qwen GSQ-RCO and Unsloth UD repacks). */
export const MAC_SETUP_QUANTS = ['Q2_0', 'IQ3_XXS', 'IQ3_S', 'UD-Q4_K_XL', 'UD-Q5_K_XL', 'UD-Q6_K_XL'];
/** setup.py mac_control_setup: the Mac installer the app drives takes only `--family qwen` at these sizes. */
export const MAC_INSTALLER_QUANTS = ['Q2_0', 'IQ3_XXS', 'IQ3_S'];
/** The official variants offered on this platform (a Mac shows only the MAC_SETUP_QUANTS sizes). */
export function platformQuants(quants: readonly string[], platform: RuntimePackagePlatform): string[] {
  return platform === 'macos' ? quants.filter(quant => MAC_SETUP_QUANTS.includes(quant)) : [...quants];
}
/** One quant of an entry: the entry's own block first, then what the Mac installer accepts (qwen, three sizes). */
export function communityQuantAvailability(model: CommunityModel, quant: string, platform: RuntimePackagePlatform): { downloadable: boolean; reason?: CommunityAvailability['reason'] | 'macQuant' } {
  const entry = communityAvailability(model, platform);
  if (!entry.downloadable) return entry;
  if (platform === 'macos' && (model.family !== 'qwen' || !MAC_INSTALLER_QUANTS.includes(quant))) return { downloadable: false, reason: 'macQuant' };
  return entry;
}

/** SHA-256 of ISTA-DASLab's official shards (setup.py ISTA_FILES): a community file with one of these is byte-identical. */
export const OFFICIAL_SHARD_SHA256 = new Set([
  '69820c02ec7d0b45ef2ebb19d6620299db749fe2aded7f39f93c6b88b199b720', '92cee27ae5bbadcd732416a0f7a7f0acc092399dbbe8f5a5efa707c2ec0a49d7',
  '219ea929900dfa9ef091f3aa473fdba6874b65fcb36526d7d851ac9e95856d15', '4c1eb2ceb4915e1192f4f386021897bde56a97f40a0bb78bb86465e0f7d2aca3',
  '316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113',
]);
export interface CommunityDiskEstimate {
  /** All files of the size (GB, decimal). */
  filesGB: number;
  /** Of those, files byte-identical to an official shard: hard-linked from an official download when present (0 extra). */
  officialGB: number;
  /** The separate pack setup builds in the community folder (runtime-core community_model.rs prepare). */
  packGB: number;
  /** MTP draft layer, only when no data folder has it yet (setup reuses it). */
  mtpGB: number;
  /** Extra disk with no official files on this PC, and with them (official shards reused). */
  worstGB: number;
  bestGB: number;
}
/** Disk the community install adds next to the official one (its own data folder): the same figures the native disk plan uses. */
export function communityDiskEstimate(model: CommunityModel, quant: string): CommunityDiskEstimate {
  const info = model.quantInfo[quant];
  const files = [...(info?.files ?? []), ...(model.controlVector ? [model.controlVector] : [])];
  const gb = (bytes: number) => Math.round(bytes / 1e8) / 10;
  const filesGB = gb(files.reduce((sum, file) => sum + file.size, 0));
  const officialGB = gb(files.filter(file => file.sha256 && OFFICIAL_SHARD_SHA256.has(file.sha256)).reduce((sum, file) => sum + file.size, 0));
  const packGB = model.family === 'qwen' && quant === 'Q2_0' ? 40 : 2;
  const mtpGB = 8;
  return { filesGB, officialGB, packGB, mtpGB, worstGB: Math.round(filesGB + packGB + mtpGB), bestGB: Math.round(filesGB - officialGB + packGB) };
}

/** Why an official family is unavailable on this platform (Metal engine scope, docs/MAC.md). */
export function officialFamilyBlock(family: string, platform: RuntimePackagePlatform): 'macFamily' | 'macInstaller' | undefined {
  if (platform !== 'macos') return undefined;
  if (!macCatalogFamilyAllowed(family)) return 'macFamily';
  // setup.py mac_control_setup (the installer the app drives on a Mac) accepts only `--family qwen`.
  return family === 'unsloth' ? 'macInstaller' : undefined;
}

export interface CommunitySetupRequest {
  slug: string; repo: string; revision: string; family: string; quant: string;
  files: CommunityFile[]; controlVector?: CommunityFile;
}
/** The native run_community_setup request for one entry + quant. Images use Strata's official, SHA-checked projector. */
export function communitySetupRequest(model: CommunityModel, quant: string): CommunitySetupRequest {
  const info = model.quantInfo[quant];
  if (!info) throw new Error(`${model.name} has no ${quant}`);
  if (model.kind === 'orca') throw new Error('OrcaRouter uses the ORCA.md import');
  return {
    slug: model.slug, repo: model.repo, revision: model.revision, family: model.family, quant,
    files: info.files.map(file => ({ ...file })),
    ...(model.controlVector ? { controlVector: { ...model.controlVector } } : {}),
  };
}

// ---- Discovery parsing (pure) ------------------------------------------------------------------
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{64}$/;
export const isRepoId = (repo: string) => REPO.test(repo) && !repo.includes('..');
export const isRevision = (revision: string) => REVISION.test(revision);

/** setup.py GGUF_QUANT / local_model.rs quant_of on a file stem (Unsloth's UD- prefix included). */
export function quantOfStem(stem: string): string | undefined {
  const tokens = stem.split('-');
  const last = tokens[tokens.length - 1] ?? '';
  if (!/^(I?Q\d+(_[A-Za-z0-9]+)*|BF16|F16|F32)$/i.test(last)) return undefined;
  const ud = tokens.length >= 2 && tokens[tokens.length - 2]!.toUpperCase() === 'UD';
  return `${ud ? 'UD-' : ''}${last.toUpperCase()}`;
}
/** local_model.rs inferred_family, restricted to layouts Strata's installer reads in place. */
export function inferFamily(stem: string, quant: string): string | undefined {
  const lower = stem.toLowerCase();
  const family = lower.includes('qwen3.6') ? 'qwen36' : lower.includes('swift') ? 'swift' : quant === 'IQ1_M' ? 'coder' : quant.startsWith('UD-') || quant === 'Q8_0' ? 'unsloth' : 'qwen';
  if (!setupSupports(family, quant)) return undefined;
  // GSQ-RCO families need ISTA-DASLab's two-shard layout (shard 2 = the n-gram table); Unsloth's need its UD files.
  if ((family === 'qwen' || family === 'swift' || family === 'coder') && !/gsq-rco/i.test(stem)) return undefined;
  if (family === 'qwen36' && !lower.includes('35b-a3b')) return undefined;
  if (family !== 'qwen36' && !lower.includes('flash-next')) return undefined;
  return family;
}

export interface HfTreeEntry { path: string; size?: number; lfs?: { oid?: string; size?: number } }
export interface HfModelInfo { id: string; sha?: string; downloads?: number; likes?: number; lastModified?: string; tags?: string[] }
/** "owner · rest" without the base-model prefix and the -GGUF suffix: rows stay on one line. */
const displayName = (repo: string) => {
  const [owner, name] = repo.split('/') as [string, string];
  const short = name.replace(/^(Huihui-)?Qwen3\.8-Flash-Next-?/i, '').replace(/[-_]?GGUF$/i, '').replace(/^-+|-+$/g, '') || name;
  return `${owner} · ${short}`;
};
const slugOf = (repo: string) => repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'model';

/** Names that say the weights were pruned or distilled: Strata's pack layout expects all 512 experts per layer. */
const ALTERED = /reap|prun|distill/i;

/**
 * One repository's tree → one community entry per Strata family with every complete, runnable quantization.
 * Rules: GGUF, quant in SUPPORTED_QUANTS and accepted for the inferred family, every shard of the set present,
 * at least 1 GB in total (Unsloth's first shard is a ~10 MB header, so sizes are judged per set), and no
 * pruned/distilled naming. Qwen3.6 is not discovered: its abliterated builds do not use Strata's layout.
 */
export function communityFromTree(info: HfModelInfo, tree: HfTreeEntry[]): CommunityModel[] {
  if (!isRepoId(info.id) || !info.sha || !isRevision(info.sha) || ALTERED.test(info.id)) return [];
  const files = tree.filter(entry => entry.path.toLowerCase().endsWith('.gguf') && !entry.path.split('/').some(part => part === '..' || part === '.'));
  const groups = new Map<string, { family: string; quant: string; total: number; shards: Map<number, CommunityFile> }>();
  let vision = false;
  for (const entry of files) {
    const size = entry.lfs?.size ?? entry.size ?? 0;
    const sha = entry.lfs?.oid && SHA.test(entry.lfs.oid) ? entry.lfs.oid : undefined;
    const name = entry.path.split('/').pop()!;
    if (/^mmproj/i.test(name)) { vision = true; continue; }
    if (ALTERED.test(entry.path)) continue;
    const shard = name.match(SHARD);
    const stem = shard ? name.slice(0, shard.index) : name.replace(/\.gguf$/i, '');
    const quant = quantOfStem(stem);
    if (!quant || !(SUPPORTED_QUANTS as readonly string[]).includes(quant)) continue;
    const family = inferFamily(stem, quant);
    if (!family || family === 'qwen36') continue;
    const key = `${entry.path.slice(0, entry.path.length - name.length)}${stem}`;
    const total = shard ? Number(shard[2]) : 1;
    const group = groups.get(key) ?? { family, quant, total, shards: new Map() };
    group.shards.set(shard ? Number(shard[1]) : 1, { path: entry.path, size, ...(sha ? { sha256: sha } : {}) });
    groups.set(key, group);
  }
  const byFamily = new Map<string, Record<string, CommunityQuant>>();
  for (const group of groups.values()) {
    if (group.shards.size !== group.total || group.total > 8) continue;
    const ordered = [...group.shards.entries()].sort((a, b) => a[0] - b[0]).map(([, file]) => file);
    if (ordered.some(file => !file.sha256) || ordered.reduce((sum, file) => sum + file.size, 0) < 1e9) continue;
    const quantInfo = byFamily.get(group.family) ?? {};
    if (quantInfo[group.quant]) continue;   // the first complete set of a quant wins
    quantInfo[group.quant] = quantEntry(ordered, group.family, group.quant);
    byFamily.set(group.family, quantInfo);
  }
  const entries: CommunityModel[] = [];
  for (const [family, quantInfo] of byFamily) {
    const quants = (SETUP_FAMILY_QUANTS[family] ?? []).filter(quant => quantInfo[quant]);
    if (!quants.length) continue;
    const suffix = family === 'qwen' ? '' : `-${family}`;
    const slug = `${slugOf(info.id).slice(0, 48 - suffix.length).replace(/-+$/, '')}${suffix}`;
    const label = family === 'qwen' ? '' : family === 'unsloth' ? ' · Unsloth UD' : ` · ${family[0]!.toUpperCase()}${family.slice(1)}`;
    entries.push({
      id: `hf:${info.id}@${family}`, slug, name: `${displayName(info.id)}${label}`, repo: info.id, revision: info.sha, family, kind: 'gsq-rco',
      images: vision && family !== 'coder', quants, quantInfo, risks: ['unverified', 'noGuardrails'],
      source: 'discovered', downloads: info.downloads, likes: info.likes, updatedAt: info.lastModified,
    });
  }
  return entries;
}

/** Repositories the list already covers (official makers and the built-in entries) are not rediscovered. */
export const OFFICIAL_REPO_OWNERS = ['ISTA-DASLab', 'ukisai', 'unsloth', 'Qwen', 'nvidia', 'agentionai'];
export function isKnownRepo(repo: string): boolean {
  const owner = repo.split('/')[0]!.toLowerCase();
  return OFFICIAL_REPO_OWNERS.some(item => item.toLowerCase() === owner) || BUILTIN_COMMUNITY_MODELS.some(model => model.repo.toLowerCase() === repo.toLowerCase());
}

/** Built-ins first, then discovered entries by downloads; Mac keeps only qwen/unsloth families. */
export function mergeCommunityModels(discovered: CommunityModel[], platform: RuntimePackagePlatform): CommunityModel[] {
  const extra = discovered.filter(model => !isKnownRepo(model.repo)).sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
  const all = [...BUILTIN_COMMUNITY_MODELS, ...extra];
  return platform === 'macos' ? all.filter(model => model.source === 'builtin' || macCatalogFamilyAllowed(model.family)) : all;
}
