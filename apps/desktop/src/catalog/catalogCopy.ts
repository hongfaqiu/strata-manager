// Strings for the 「选择模型」 community entries, Mac availability and the 估算 performance figures, shared by the
// first-run guide and the Models page. zh-CN / zh-TW read the Chinese text, every other language the English one.
import type { AppLanguage, CommunityMacBlock, CommunityRisk, PerformanceBasis, PerformanceMode } from '@strata-manager/core';

export interface CatalogCopy {
  scopeOfficial: string; scopeCommunity: string; scopeLabel: string;
  communityBadge: string; discoveredBadge: string; officialBadge: string;
  communityIntro: string; sourceRepo: string; risksHeading: string; revision: string;
  risk: Record<CommunityRisk, string>;
  block: Record<CommunityMacBlock | 'macQuant', string>;
  blockSource: string;
  orcaImport: string; orcaOpen: string;
  macUnavailableHeading: string;
  estimate: string; ttft: string; noData: string; tokS: string;
  basis: Record<PerformanceBasis, string>;
  mode: Record<PerformanceMode, string>;
  need: (gb: number) => string; machine: (gb: number) => string; download: (gb: number | string) => string;
  streamingNote: (machine: number, need: number, from: number) => string;
  residentNote: (need: number) => string;
  lowRamNote: (need: number) => string;
  estimateMethod: string;
  discovery: Record<'fresh' | 'cached' | 'stale' | 'offline' | 'loading', string>;
  refresh: string;
  downloadCommunity: (gb: number | string) => string;
  pipelineNote: string; projectorNote: string; controlVectorNote: string;
  diskTitle: string; diskExtra: (worst: number, best: number) => string; diskParts: (files: number, pack: number, mtp: number) => string; diskReuse: (official: number) => string;
  macUnslothInstaller: string;
  colModel: string; colSpeed: string;
  stats: (downloads: number, likes: number) => string;
}

const k = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);

const zh: CatalogCopy = {
  scopeOfficial: '官方', scopeCommunity: '社区 · 无审查', scopeLabel: '模型来源',
  communityBadge: '社区 · 无审查', discoveredBadge: '自动发现', officialBadge: '官方',
  communityIntro: '第三方发布的去审查版本。默认推荐仍是官方版本；Manager 只校验文件完整（固定提交 + SHA-256），不保证模型行为。',
  sourceRepo: '来源仓库', risksHeading: '风险提示', revision: '固定提交',
  risk: {
    noGuardrails: '已去除拒答：模型几乎不再拒绝请求，输出内容由你自己负责。',
    mtpNotAbliterated: 'MTP 草稿头没有做去审查（沿用官方草稿层）：草稿偏向原模型，最终每个 token 仍由主模型校验。',
    agentPersistence: '去审查后，长链路 Agent 任务的坚持度可能下降（社区反馈）。',
    unverified: '从 Hugging Face 自动发现，未经 Manager 或上游验证；只按文件名、量化和分片完整性筛选。',
    textOnly: '仅文本，不支持图片。',
    orcaRam: '需要约 49.8 GiB 可用内存作专家缓存（ORCA.md）。',
    controlVectorMac: '去拒答向量只在 PC 引擎生效；Strata 自带同类的「实验投影」（--experimental-speed-projection），用官方模型也能开启。',
  },
  block: {
    macGemv: 'Mac 不可用：Metal 引擎的 gemv 没有 IQ3_XXS 专家内核（上游 PR #2931 未合并），且需要 49.8 GiB 专家缓存。',
    macControlVector: '去拒答向量在 Mac 引擎未移植，等同官方版。',
    macFamily: 'Mac 暂不可用：上游 Metal 引擎目前不支持 Swift、Coder 和 Qwen3.6（MAC.md）。',
    macQuant: 'Mac 安装器只接受 Qwen3.8-Flash-Next 的 Q2_0、IQ3_XXS、IQ3_S，这个版本在 Mac 上不能一键安装。',
  },
  blockSource: '上游依据',
  orcaImport: '按 ORCA.md 手动兼容流程导入（独立打包，不改名）。', orcaOpen: '打开 OrcaRouter 导入',
  macUnavailableHeading: 'Mac 暂不可用',
  estimate: '估算', ttft: '首字', noData: '无公开数据', tokS: 'tok/s',
  basis: {
    macM5Max: '参考 M5 Max 128 GB 实测（MAC.md）；内存带宽更低的芯片会更慢',
    macStream: '参考 M4 32 GB 与 M1 Max 34 GB 的 SSD 流式实测（MAC.md）',
    macStreamExtrapolated: '无 IQ3_S 流式实测：由 IQ3_XXS 流式实测按专家体积（43→50 GB）外推',
    pcRtx5070: '参考 RTX 5070 12 GB + 64 GB 内存实测（MODELS.md，短对话 / 128K 上下文）',
    pcRtx4090: '参考 RTX 4090 24 GB 社区实测（上游 bench/results，4K–128K 提示词）；显存越大，缓存在显卡上的专家越多、越快',
    pcNvidia32: '参考 32 GB 显存 RTX 4080 SUPER + 64 GB 内存的排行榜实测（为下限；RTX 5090 32 GB 上游社区实测 127–170）',
    pcRx9070xt: '参考 RX 9070 XT 16 GB + 47 GB 内存实测（MODELS.md）',
    pcR9700: '参考 Radeon AI PRO R9700 32 GB 实测（MODELS.md）',
    pcRtx3060: '参考 RTX 3060 12 GB 实测（MODELS.md / QWEN36.md）',
    none: '上游文档没有这个组合的实测',
  },
  mode: { macResident: '常驻内存', macStreaming: 'SSD 流式 · 会变慢', macUnsupported: 'Mac 不支持', gpu: '内存够用', lowRam: '低内存模式 · 明显变慢', tooSmall: '内存不足', unknown: '未知' },
  need: gb => `需约 ${gb} GB`, machine: gb => `本机 ${gb} GB`, download: gb => `下载 ${gb} GB`,
  streamingNote: (machine, need, from) => `本机 ${machine} GB 统一内存放不下整个模型（约需 ${need} GB，${from} GB 起可常驻）。引擎会自动把专家从 SSD 流式读取：能运行，不会失败，只是更慢——上游实测 M4 32 GB 的 Q2_0 为 13.5–14.1 tok/s，M1 Max 34 GB 为 7.9 tok/s。内存越大，专家缓存越大、越快；模型需放在内置 SSD。`,
  residentNote: need => `约需 ${need} GB 统一内存，整个模型常驻内存。`,
  lowRamNote: need => `内存低于约 ${need} GB（专家 + 10 GB）时，安装器改用低内存模式，专家从 SSD 读取，速度明显下降（MODELS.md 没有给出数字）。`,
  estimateMethod: '速度与首字延迟是「估算」：取自 Strata 文档中相同模型/量化的公开实测，按本机内存与显卡选择最接近的参考硬件；首字 = 4K 提示词 ÷ 实测读取速度。不是本机实测。',
  discovery: { fresh: '社区列表已从 Hugging Face 更新', cached: '社区列表来自 24 小时内的缓存', stale: '无法连接 Hugging Face，显示上次缓存', offline: '无法连接 Hugging Face，只显示内置条目', loading: '正在检查 Hugging Face…' },
  refresh: '刷新',
  downloadCommunity: gb => `下载并准备 · ${gb} GB`,
  pipelineNote: '下载固定提交的文件并逐个校验 SHA-256，再用官方安装器（--gguf-dir）准备；配置单独登记为 community-…，不覆盖官方配置。',
  projectorNote: '图片使用官方视觉编码器（安装器只接受官方 SHA-256）。',
  controlVectorNote: '分片与官方 ISTA-DASLab 文件逐字节相同，另加一个去拒答控制向量（安装时以 --experimental-speed-projection 传入）。',
  diskTitle: '预计额外占用磁盘',
  diskExtra: (worst, best) => best === worst ? `约 ${worst} GB` : `约 ${best}–${worst} GB`,
  diskParts: (files, pack, mtp) => `社区版装在独立的数据目录（不动官方安装）：模型文件 ${files} GB + 独立打包 ${pack} GB + MTP 草稿层最多 ${mtp} GB（已有则复用）。`,
  diskReuse: official => `其中 ${official} GB 与官方分片逐字节相同：本机已下载官方版时，校验 SHA-256 后以硬链接复用，不再下载、也不额外占用（跨磁盘时改为本地复制）。`,
  macUnslothInstaller: 'Mac 暂不可用：上游 Mac 安装器只接受 Qwen3.8-Flash-Next（--family qwen）的 Q2_0 / IQ3_XXS / IQ3_S，Unsloth 的多分片文件目前要用 ./setup.sh 重新打包，应用里无法安装（MAC.md）。',
  colModel: '模型与量化', colSpeed: '速度（估算）',
  stats: (downloads, likes) => `${k(downloads)} 次下载 · ${k(likes)} 赞`,
};

const en: CatalogCopy = {
  scopeOfficial: 'Official', scopeCommunity: 'Community · uncensored', scopeLabel: 'Model source',
  communityBadge: 'Community · uncensored', discoveredBadge: 'Discovered', officialBadge: 'Official',
  communityIntro: 'Uncensored builds published by third parties. The official model stays the default recommendation; Manager only checks file integrity (pinned commit + SHA-256), not model behaviour.',
  sourceRepo: 'Source repository', risksHeading: 'Risks', revision: 'Pinned commit',
  risk: {
    noGuardrails: 'Refusals removed: the model declines almost nothing; you are responsible for what it writes.',
    mtpNotAbliterated: 'The MTP draft head is not abliterated (the official draft layer is reused): drafts lean toward the original model; the main model still checks every token.',
    agentPersistence: 'Persistence on long agent tasks may drop after abliteration (community reports).',
    unverified: 'Discovered on Hugging Face, not verified by Manager or upstream; filtered only by file names, quantization and complete shard sets.',
    textOnly: 'Text only, no pictures.',
    orcaRam: 'Needs about 49.8 GiB of available RAM for the expert arena (ORCA.md).',
    controlVectorMac: 'The refusal-direction vector works on the PC engines only; Strata ships a similar "experimental speed projection" (--experimental-speed-projection) you can turn on with the official model.',
  },
  block: {
    macGemv: 'Not available on a Mac: the Metal gemv has no IQ3_XXS expert kernel (upstream PR #2931 is not merged), and it needs a 49.8 GiB expert arena.',
    macControlVector: 'The refusal vector is not ported to the Mac engine; this equals the official model.',
    macFamily: 'Not available on a Mac yet: the upstream Metal engine does not run Swift, Coder or Qwen3.6 (MAC.md).',
    macQuant: 'The Mac installer takes only Qwen3.8-Flash-Next Q2_0, IQ3_XXS and IQ3_S, so this build cannot be installed with one click on a Mac.',
  },
  blockSource: 'Upstream reference',
  orcaImport: 'Imported with the manual ORCA.md workflow (standalone pack, no renaming).', orcaOpen: 'Open the OrcaRouter import',
  macUnavailableHeading: 'Not available on a Mac',
  estimate: 'est.', ttft: 'first token', noData: 'No published data', tokS: 'tok/s',
  basis: {
    macM5Max: 'Based on M5 Max 128 GB measurements (MAC.md); chips with less memory bandwidth are slower',
    macStream: 'Based on SSD-streaming measurements on an M4 32 GB and an M1 Max 34 GB (MAC.md)',
    macStreamExtrapolated: 'No IQ3_S streaming measurement: extrapolated from IQ3_XXS streaming by expert bytes (43→50 GB)',
    pcRtx5070: 'Based on RTX 5070 12 GB + 64 GB RAM measurements (MODELS.md, short chat / 128K context)',
    pcRtx4090: 'Based on RTX 4090 24 GB community measurements (upstream bench/results, 4K–128K prompts); more VRAM caches more experts on the card and is faster',
    pcNvidia32: 'Based on leaderboard runs of an RTX 4080 SUPER with 32 GB VRAM + 64 GB RAM (a lower bound; an RTX 5090 32 GB measured 127–170 in upstream community runs)',
    pcRx9070xt: 'Based on RX 9070 XT 16 GB + 47 GB RAM measurements (MODELS.md)',
    pcR9700: 'Based on Radeon AI PRO R9700 32 GB measurements (MODELS.md)',
    pcRtx3060: 'Based on RTX 3060 12 GB measurements (MODELS.md / QWEN36.md)',
    none: 'Upstream docs have no measurement for this combination',
  },
  mode: { macResident: 'Resident', macStreaming: 'Streams from SSD · slower', macUnsupported: 'Not on Mac', gpu: 'RAM fits', lowRam: 'Low-RAM mode · much slower', tooSmall: 'Too little memory', unknown: 'Unknown' },
  need: gb => `needs ~${gb} GB`, machine: gb => `this machine ${gb} GB`, download: gb => `${gb} GB download`,
  streamingNote: (machine, need, from) => `${machine} GB of unified memory cannot hold the whole model (needs ~${need} GB; resident from ${from} GB). The engine then streams the experts from the SSD by itself: it runs and does not fail, it is just slower — upstream measured 13.5–14.1 tok/s for Q2_0 on an M4 32 GB and 7.9 tok/s on an M1 Max 34 GB. More memory means a bigger expert cache and more speed; keep the model on the internal SSD.`,
  residentNote: need => `Needs ~${need} GB of unified memory; the whole model stays resident.`,
  lowRamNote: need => `Below ~${need} GB of RAM (experts + 10 GB) setup uses the low-RAM mode: experts come from the SSD and it is much slower (MODELS.md gives no number).`,
  estimateMethod: 'Speed and time to first token are estimates: published measurements of the same model/quant in Strata\'s docs, from the reference hardware closest to this machine\'s memory and GPU; first token = a 4K prompt ÷ the measured reading speed. Not measured on this machine.',
  discovery: { fresh: 'Community list updated from Hugging Face', cached: 'Community list from the cache (under 24 h)', stale: 'Hugging Face unreachable; showing the last cache', offline: 'Hugging Face unreachable; built-in entries only', loading: 'Checking Hugging Face…' },
  refresh: 'Refresh',
  downloadCommunity: gb => `Download and prepare · ${gb} GB`,
  pipelineNote: 'Downloads the files of the pinned commit, checks each SHA-256, then prepares them with the official installer (--gguf-dir); the config is registered separately as community-… and never replaces the official one.',
  projectorNote: 'Pictures use the official vision encoder (the installer accepts only the official SHA-256).',
  controlVectorNote: 'The shards are byte-identical to the official ISTA-DASLab files, plus a refusal-direction control vector (passed as --experimental-speed-projection).',
  diskTitle: 'Estimated extra disk',
  diskExtra: (worst, best) => best === worst ? `about ${worst} GB` : `about ${best}–${worst} GB`,
  diskParts: (files, pack, mtp) => `Community builds go into their own data folder (the official install is untouched): model files ${files} GB + a separate pack ${pack} GB + the MTP draft layer up to ${mtp} GB (reused when present).`,
  diskReuse: official => `${official} GB of that is byte-identical to official shards: when the official build is already downloaded, it is reused through a hard link after a SHA-256 check, with no download and no extra disk (a local copy across drives).`,
  macUnslothInstaller: 'Not available on Mac yet: the upstream Mac installer takes only Qwen3.8-Flash-Next (--family qwen) at Q2_0 / IQ3_XXS / IQ3_S; Unsloth’s many-shard files need the ./setup.sh repack for now, so the app cannot install them (MAC.md).',
  colModel: 'Model and quantization', colSpeed: 'Speed (est.)',
  stats: (downloads, likes) => `${k(downloads)} downloads · ${k(likes)} likes`,
};

export const catalogCopy = (language: AppLanguage): CatalogCopy => language === 'zh-CN' || language === 'zh-TW' ? zh : en;
export const catalogCopies = { zh, en };
