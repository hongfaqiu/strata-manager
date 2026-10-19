import { legacyLanguage, type AppLanguage } from '@strata-manager/core';

/** 「使用已有模型」(#75) copy. Feature copy is zh-CN/en; other interface languages use English. */
export interface ExistingModelCopy {
  title: string; intro: string; files: string; chooseFolder: string; chooseFile: string; noPath: string; rescan: string; scanning: string;
  noGgufs: string; quantLegend: string; variants: (n: number) => string; shards: (n: number) => string;
  kind: Record<'official' | 'renamed' | 'orca' | 'unsupported' | 'unknown', string>;
  usable: string; checkFirst: string; unusable: string; shardState: Record<'ok' | 'missing' | 'unreadable' | 'notGguf' | 'tooSmall', string>;
  mtpTitle: string; mtpHint: string; mtpChoose: string; mtpClear: string; mtpNone: string; mtpChecking: string; mtpFound: (gb: string) => string; mtpSetupMap: (dir: string) => string; mtpOrcaMap: string;
  context: string; orcaContext: string; vision: string; checks: string; checking: string; disk: string; diskReady: string; diskNeed: (gb: string) => string; diskUnknown: string; diskLow: string;
  engine: (min: string, current: string) => string; command: string; commandHint: string; start: string; starting: string; footnote: string; orcaFootnote: string;
  needRuntime: string; needDesktop: string; chooseVariant: string; started: string;
}

const zh: ExistingModelCopy = {
  title: '使用已有模型', intro: '已经下载过 GGUF 文件？选择文件夹或其中一个分片，Manager 会识别模型与量化版本、检查文件，然后用官方安装器的 --gguf-dir 原地使用这些文件，不再下载模型权重。',
  files: '模型文件', chooseFolder: '选择文件夹…', chooseFile: '选择 GGUF 文件…', noPath: '尚未选择', rescan: '重新扫描', scanning: '正在扫描 GGUF 文件…',
  noGgufs: '这个位置没有找到 GGUF 模型文件（mmproj 视觉文件不计入）。请选择存放模型分片的文件夹。',
  quantLegend: '选择模型与量化版本', variants: n => `${n} 个量化版本`, shards: n => `${n} 个分片`,
  kind: { official: '官方文件', renamed: '文件名不同', orca: 'OrcaRouter 去审查', unsupported: '引擎不支持', unknown: '无法识别' },
  usable: '可用', checkFirst: '可用 · 请确认', unusable: '不可用',
  shardState: { ok: '正常', missing: '缺失', unreadable: '无法读取', notGguf: '不是 GGUF 文件', tooSmall: '文件过小' },
  mtpTitle: 'MTP 草稿层（可选）', mtpHint: '已有 MTP 草稿层时选择它所在的文件夹（含 rt/experts.bin），用于推测解码，避免再次下载约 5 GB；不选则由安装器自动准备。',
  mtpChoose: '选择 MTP 文件夹…', mtpClear: '清除', mtpNone: '未选择，安装器会自动查找或下载', mtpChecking: '正在检查 MTP…', mtpFound: gb => `找到 experts.bin（${gb} GB）`,
  mtpSetupMap: dir => `上游 setup.py 没有 --mtp 安装参数；它在数据目录的 mtp/rt 中查找 MTP，因此将以 --data-dir ${dir} 运行。`,
  mtpOrcaMap: '将写入配置并以引擎参数 --mtp 使用。',
  context: '上下文长度', orcaContext: '上下文固定为 32K（ORCA.md）', vision: '图像支持未启用：已有模型流程不处理 mmproj 视觉文件，需要时可在配置页开启。',
  checks: '使用前检查', checking: '正在检查…', disk: '磁盘', diskReady: '空间足够（模型权重不再下载）', diskNeed: gb => `还需约 ${gb} GB（打包、MTP、运行环境）`, diskUnknown: '磁盘空间尚未核验', diskLow: '磁盘空间不足',
  engine: (min, current) => `此模型需要引擎 ${min} 或更新（当前：${current}）。请先更新 Strata。`,
  command: '等效命令', commandHint: 'Manager 会以这些参数运行官方安装器（另加 --yes --setup --no-start）。',
  start: '使用已有模型', starting: '正在检查并提交…', footnote: '检查 → 打包 → 生成配置，完成后在“我的模型”启用。原文件不会被移动或修改。',
  orcaFootnote: '按 ORCA.md 打包并生成 strata-orca-iq3_xxs.json；仅文本，原文件不会被移动或修改。',
  needRuntime: '请先准备或选择一个 Strata 运行环境，再使用已有模型。', needDesktop: '需要桌面版后台才能读取本机文件。', chooseVariant: '请选择一个可用的量化版本。', started: '已提交，进度见下载任务。',
};

const en: ExistingModelCopy = {
  title: 'Use an existing model', intro: 'Already downloaded GGUF files? Choose the folder or one of its shards. Manager identifies the model and quantization, checks the files, and has the official installer use them in place with --gguf-dir — no weights are downloaded again.',
  files: 'Model files', chooseFolder: 'Choose folder…', chooseFile: 'Choose GGUF file…', noPath: 'Nothing chosen', rescan: 'Rescan', scanning: 'Scanning GGUF files…',
  noGgufs: 'No GGUF model files were found here (mmproj vision files are ignored). Choose the folder that holds the model shards.',
  quantLegend: 'Choose the model and quantization', variants: n => `${n} ${n === 1 ? 'quantization' : 'quantizations'}`, shards: n => `${n} ${n === 1 ? 'shard' : 'shards'}`,
  kind: { official: 'Official files', renamed: 'Different file name', orca: 'OrcaRouter uncensored', unsupported: 'Not supported by the engine', unknown: 'Not recognized' },
  usable: 'Usable', checkFirst: 'Usable · confirm', unusable: 'Unavailable',
  shardState: { ok: 'OK', missing: 'Missing', unreadable: 'Unreadable', notGguf: 'Not a GGUF file', tooSmall: 'Too small' },
  mtpTitle: 'MTP draft layer (optional)', mtpHint: 'If you already have the MTP draft layer, choose its folder (with rt/experts.bin) for speculative decoding and skip the ~5 GB download. Otherwise the installer prepares it.',
  mtpChoose: 'Choose MTP folder…', mtpClear: 'Clear', mtpNone: 'Not chosen; the installer finds or downloads it', mtpChecking: 'Checking MTP…', mtpFound: gb => `Found experts.bin (${gb} GB)`,
  mtpSetupMap: dir => `Upstream setup.py has no --mtp setup flag; it looks for MTP under the data folder's mtp/rt, so setup runs with --data-dir ${dir}.`,
  mtpOrcaMap: 'Written to the configuration and passed to the engine as --mtp.',
  context: 'Context length', orcaContext: 'Context is fixed at 32K (ORCA.md)', vision: 'Image support is off: this flow does not handle mmproj vision files. Turn it on later from the configuration page if needed.',
  checks: 'Checks', checking: 'Checking…', disk: 'Disk', diskReady: 'Enough space (weights are not downloaded again)', diskNeed: gb => `About ${gb} GB more needed (pack, MTP, runtime)`, diskUnknown: 'Disk space is unverified', diskLow: 'Insufficient disk space',
  engine: (min, current) => `This model needs engine ${min} or newer (current: ${current}). Update Strata first.`,
  command: 'Equivalent command', commandHint: 'Manager runs the official installer with these arguments (plus --yes --setup --no-start).',
  start: 'Use existing model', starting: 'Checking and submitting…', footnote: 'Check → pack → create configuration. Enable it from My models when ready. Your files are never moved or changed.',
  orcaFootnote: 'Packed per ORCA.md into strata-orca-iq3_xxs.json; text only. Your files are never moved or changed.',
  needRuntime: 'Prepare or choose a Strata runtime first, then use an existing model.', needDesktop: 'Reading local files requires the desktop backend.', chooseVariant: 'Choose a usable quantization.', started: 'Submitted. See Download tasks for progress.',
};

export const existingModelCopy = (language: AppLanguage): ExistingModelCopy => legacyLanguage(language) === 'zh-CN' ? zh : en;
