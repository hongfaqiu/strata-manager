import type { JsonObject } from '@strata-manager/core';
import { gpuRoles as R } from '@strata-manager/core';
import { useState } from 'react';
import { Segmented } from '../OfficialControls';
import './gpu-roles-editor.css';

type Role = R.Role;
type Card = R.RoleCard;

/** `environmentInfo().gpus` lines ("NVIDIA GeForce RTX 4090, 560.94, 24564 MiB") in nvidia-smi order: the card numbers Strata uses. */
export function cardsFromEnvironment(gpus: readonly string[] | undefined): Card[] {
  return (gpus ?? []).map((line, index) => {
    const parts = line.split(',').map(part => part.trim()).filter(Boolean);
    const name = parts[0] ?? `GPU ${index + 1}`;
    const memory = parts.find(part => /\d\s*(MiB|MB|GiB|GB)$/i.test(part));
    const amount = memory ? Number(memory.match(/[\d.]+/)?.[0]) : NaN;
    const vram = Number.isFinite(amount) && amount > 0 ? (/G/i.test(memory!) ? amount : amount / 1024) : 0;
    const vendor = /nvidia|geforce|rtx|quadro|tesla/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel|arc/i.test(name) ? 'intel' : /apple/i.test(name) ? 'apple' : undefined;
    return { index, name, vram_gb: Math.round(vram), vendor, integrated: /uhd|iris|integrated|radeon\(tm\) graphics|780m|680m|890m/i.test(name) || undefined };
  });
}

const words = { main: ['主卡', 'Main'], helper: ['辅助', 'Helper'], off: ['关闭', 'Off'] } as const;

interface Props {
  zh: boolean; config: JsonObject; cards: Card[]; mac: boolean; disabled: boolean; showParameterNames: boolean;
  onChange: (next: JsonObject) => void;
}

/** Strata 0.2.2 GPU roles (Main / Helper / Off) written as "gpu_roles" plus the legacy "gpu" mirror, the way the upstream app writes them. */
export function GpuRolesEditor({ zh, config, cards: detected, mac, disabled, showParameterNames, onChange }: Props) {
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [note, setNote] = useState('');
  const saved = R.savedRoles(config);
  const stored = R.parseSaved(config.gpu_roles);
  // Cards the config names but this computer did not list stay visible (a card that is unplugged, or a list the probe could not read).
  const cards: Card[] = [...detected];
  for (const index of Object.keys(stored ?? {}).map(Number)) if (!cards.some(card => card.index === index)) cards.push({ index, name: `GPU ${index + 1}`, vram_gb: 0 });
  cards.sort((a, b) => a.index - b.index);
  const shown: R.Roles = stored ?? (cards.length ? R.fromLegacy(config.gpu, cards, typeof config.gpu_order === 'string' ? config.gpu_order : null) : {});
  const allOff = Object.keys(shown).length > 0 && Object.values(shown).every(role => role === 'off');
  const runsWithoutCard = R.engineRunsWithoutCard(config, mac);
  const name = (index: number) => { const card = cards.find(c => c.index === index); return card ? R.shortName(card) : `GPU ${index + 1}`; };
  const noteText = (code: string | null) => {
    if (!code) return '';
    const [kind, arg] = code.split(':');
    if (kind === 'old_main_helper') return t(`${name(Number(arg))} 已改为辅助。`, `${name(Number(arg))} is now a Helper.`);
    if (kind === 'promoted') return t(`${name(Number(arg))} 已改为主卡。`, `${name(Number(arg))} is now Main.`);
    if (kind === 'only_main') return t('唯一打开的卡只能是主卡。', 'The only card that is on has to be Main.');
    return '';
  };
  const set = (index: number, role: Role) => {
    const base: R.Roles = { ...Object.fromEntries(cards.map(card => [card.index, 'off' as Role])), ...shown };
    const change = R.setRole(base, cards, index, role);
    setNote(noteText(change.note));
    onChange(R.applyRoles(config, change.roles, cards));
  };
  const warnings = R.warnings(shown, cards, { engineRunsCpuOnly: runsWithoutCard }).filter(w => w.code !== 'cpu_only');
  const warningText = (w: R.RoleWarning) => w.code === 'cannot_run' ? t(`${name(w.card!)} 无法运行 Strata，建议设为关闭。`, `${name(w.card!)} cannot run Strata; set it to Off.`)
    : w.code === 'igpu_main' ? t(`${name(w.card!)} 是集成显卡，作为主卡会很慢。`, `${name(w.card!)} is built-in graphics; it is slow as Main.`) : w.text;
  return <section className="startup-tuning-group gpu-roles-editor" aria-label={t('显卡角色', 'GPU roles')} data-testid="gpu-roles-editor">
    <div className="gpu-roles-heading"><h3>{t('显卡角色', 'GPU roles')}</h3>{showParameterNames && <code>gpu_roles</code>}</div>
    <p className="gpu-roles-hint">{t('主卡运行每次回答的最后一段（输出层与草稿校验），只能有一张；辅助卡分担模型，让更多权重放进显存；关闭的卡 Strata 不使用。需要 Strata 0.2.2 及以上，旧版本只读取下方的 GPU 编号。', 'Main runs the last stage of every answer (the output head and draft check); there is exactly one. Helpers hold a share of the model so more of it fits in graphics memory. Strata leaves Off cards alone. Needs Strata 0.2.2 or newer; older versions read only the GPU indices below.')}</p>
    {saved.problem === 'edited' && <p className="notice warning" role="status">{t('配置里的 “gpu” 已被手动修改，与显卡角色不一致：Strata 会以 “gpu” 为准并忽略 gpu_roles。在下方改一次角色即可让两者一致，或在“路径与 GPU 分配”里清空 “gpu”。', 'The config’s “gpu” was edited by hand and no longer matches the roles: Strata uses “gpu” and ignores gpu_roles. Change a role below to bring them back in line, or clear “gpu” under Paths and GPU allocation.')}</p>}
    {saved.problem === 'invalid' && <p className="notice warning" role="status">{t('gpu_roles 不是 {卡号: main|helper|off} 且最多一张 main 的格式，Strata 会忽略它。在下方重新选择角色即可修正。', 'gpu_roles is not {card: main|helper|off} with at most one main, so Strata ignores it. Choose the roles below to fix it.')}</p>}
    {saved.problem === 'gpu_invalid' && <p className="notice warning" role="status">{t('“gpu” 不是卡号或卡号列表，Strata 会忽略 gpu_roles。', '“gpu” is not a card number or a list, so Strata ignores gpu_roles.')}</p>}
    {cards.length ? <div className="gpu-roles-list" role="group" aria-label={t('每张显卡的角色', 'Role of each card')}>{cards.map(card => {
      const role = shown[card.index] ?? 'off';
      return <div className={`gpu-roles-row is-${role}`} key={card.index}>
        <span className="gpu-roles-card"><strong>GPU {card.index + 1}</strong><small>{card.name}{card.vram_gb ? ` · ${card.vram_gb} GB` : ''} · {t(`编号 ${card.index}`, `index ${card.index}`)}</small></span>
        <Segmented ariaLabel={t(`GPU ${card.index + 1} 的角色`, `Role of GPU ${card.index + 1}`)} value={role} onValueChange={value => { if (!disabled) set(card.index, value as Role); }} options={R.ROLES.map(value => ({ value, label: zh ? words[value][0] : words[value][1], disabled }))}/>
      </div>;
    })}</div> : <p className="gpu-roles-hint">{t('未检测到显卡列表。可在“系统”页刷新后再设置；当前配置保持不变。', 'No graphics card list was detected. Refresh on the System page and set roles then; the config is unchanged.')}</p>}
    {allOff && (runsWithoutCard
      ? <p className="notice warning" role="status">{t('所有显卡都已关闭：将只用 CPU 运行，速度会明显变慢。', 'Every card is Off: Strata runs on the CPU only, and performance is degraded.')}</p>
      : <p className="notice error" role="alert">{t('所有显卡都已关闭：此引擎（CUDA / HIP / SYCL）至少需要一张主卡或辅助卡，启动时会直接失败。请打开一张卡。', 'Every card is Off: this engine (CUDA / HIP / SYCL) needs a Main or Helper card and will refuse to start. Turn a card on.')}</p>)}
    {warnings.map(w => <p className="notice warning" role="status" key={`${w.code}-${w.card}`}>{warningText(w)}</p>)}
    {note && <p className="gpu-roles-hint" role="status">{note}</p>}
    <div className="gpu-roles-footer">
      {stored ? <span className="gpu-roles-hint">{t('引擎使用的显卡顺序（主卡在最后）：', 'Cards the engine gets (Main last): ')}<code>{JSON.stringify(R.configGpuIds(config))}</code></span> : <span className="gpu-roles-hint">{t('尚未设置角色，按上方显示的推荐/现有 GPU 编号运行。', 'No roles are set; the card choice shown above (recommended or the existing GPU indices) is used.')}</span>}
      {stored && <button type="button" disabled={disabled} onClick={() => { setNote(''); onChange(R.clearRoles(config)); }}>{t('清除角色，恢复自动选择', 'Clear roles (automatic choice)')}</button>}
    </div>
  </section>;
}
