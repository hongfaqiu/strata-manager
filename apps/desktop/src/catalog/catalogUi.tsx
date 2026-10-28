// Shared pieces of the 「选择模型」 list: community discovery hook, hardware for the 估算 figures, the speed and
// memory cells, the community badge and risk list. Restrained on purpose: one accent, muted secondary text.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, TriangleAlert } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { CommunityModel, PerformanceEstimate, PerformanceHardware, RuntimePackagePlatform } from '@strata-manager/core';
import { parseGpu } from '../onboarding/onboardingModel';
import type { CatalogCopy } from './catalogCopy';
import './catalog.css';

export function catalogHardware(platform: RuntimePackagePlatform, memoryGB: number | undefined, gpus: string[] | undefined): PerformanceHardware {
  const parsed = (gpus ?? []).map(parseGpu);
  const best = [...parsed].sort((a, b) => (b.vramGB ?? 0) - (a.vramGB ?? 0))[0];
  const vendor = !best ? undefined : best.nvidia ? 'nvidia' as const : /amd|radeon|rx\s?\d/i.test(best.name) ? 'amd' as const : 'other' as const;
  return { platform, memoryGB, vramGB: best?.vramGB, gpuVendor: vendor, gpuName: best?.name };
}

/** Built-in entries at once; discovered ones after the (cached, 24 h) Hugging Face check. Never throws. */
export function useCommunityModels(platform: RuntimePackagePlatform, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['community-models'], queryFn: () => core.discoverCommunityModels(), enabled, staleTime: 60 * 60_000, retry: false, refetchOnWindowFocus: false });
  const models = core.mergeCommunityModels(query.data?.entries ?? [], platform);
  const state = query.isFetching && !query.data ? 'loading' as const : query.data?.state ?? (query.isError ? 'offline' as const : 'loading' as const);
  const refresh = async () => { const result = await core.discoverCommunityModels({ force: true }); client.setQueryData(['community-models'], result); };
  return { models, state, fetchedAt: query.data?.fetchedAt, refresh };
}

const round = (value: number) => value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;

/** "8–14 tok/s" with "估算 · 首字 22–51 s" below; the basis goes into the tooltip. */
export function EstimateCell({ estimate, copy }: { estimate: PerformanceEstimate; copy: CatalogCopy }) {
  const decode = core.formatRange(estimate.decode, estimate.bound);
  const ttft = core.formatRange(estimate.ttft4k, undefined, 1);
  const title = `${copy.basis[estimate.basis]}${estimate.extrapolated ? ' · ' + copy.basis.macStreamExtrapolated : ''}`;
  if (!decode) return <span className="cat-est is-none" title={title}><small>{estimate.mode === 'lowRam' ? copy.mode.lowRam : copy.noData}</small></span>;
  return <span className="cat-est" title={title}>
    <span className="cat-est-main"><b>{decode}</b> {copy.tokS}</span>
    <small><em className="cat-est-tag">{copy.estimate}</em>{ttft ? ` · ${copy.ttft} ${ttft} s` : ''}</small>
  </span>;
}

/** One short line: "需约 46 GB · 本机 48 GB · SSD 流式 · 会变慢". */
export function memoryLine(estimate: PerformanceEstimate, fallbackGB: number, memoryGB: number | undefined, copy: CatalogCopy): string {
  const need = round(estimate.memoryGB ?? fallbackGB);
  const parts = [copy.need(need)];
  if (memoryGB) parts.push(copy.machine(Math.round(memoryGB)));
  if (estimate.mode !== 'unknown' && estimate.mode !== 'gpu') parts.push(copy.mode[estimate.mode]);
  else if (memoryGB) parts.push(need <= memoryGB ? copy.mode.gpu : copy.mode.lowRam);
  return parts.join(' · ');
}

export function CommunityBadge({ model, copy }: { model: CommunityModel; copy: CatalogCopy }) {
  return <span className="cat-badges"><em className="cat-badge is-community">{copy.communityBadge}</em>{model.source === 'discovered' && <em className="cat-badge">{copy.discoveredBadge}</em>}</span>;
}

export function CommunitySource({ model, copy }: { model: CommunityModel; copy: CatalogCopy }) {
  return <div className="cat-source">
    <a href={`https://huggingface.co/${model.repo}/tree/${model.revision}`} target="_blank" rel="noreferrer">{model.repo}<ArrowUpRight size={12}/></a>
    <small>{copy.revision} <code>{model.revision.slice(0, 7)}</code>{model.downloads !== undefined && model.likes !== undefined ? ` · ${copy.stats(model.downloads, model.likes)}` : ''}</small>
  </div>;
}

export function CommunityRisks({ model, copy }: { model: CommunityModel; copy: CatalogCopy }) {
  return <div className="cat-risks"><h4><TriangleAlert size={13}/>{copy.risksHeading}</h4><ul>{model.risks.map(risk => <li key={risk}>{copy.risk[risk]}</li>)}</ul></div>;
}

export function BlockNote({ reason, source, copy }: { reason: keyof CatalogCopy['block']; source?: string; copy: CatalogCopy }) {
  return <p className="cat-block">{copy.block[reason]}{source && <> <a href={source} target="_blank" rel="noreferrer">{copy.blockSource}<ArrowUpRight size={11}/></a></>}</p>;
}

/** The SSD-streaming / low-RAM explanation for the selected row, with the doc sources. */
export function MemoryNote({ estimate, memoryGB, copy }: { estimate: PerformanceEstimate; memoryGB?: number; copy: CatalogCopy }) {
  if (estimate.mode === 'macStreaming' && estimate.memoryGB && estimate.residentFromGB) return <p className="cat-note">{copy.streamingNote(Math.round(memoryGB ?? 0), estimate.memoryGB, estimate.residentFromGB)} <a href={core.PERFORMANCE_SOURCES.macStream} target="_blank" rel="noreferrer">MAC.md<ArrowUpRight size={11}/></a></p>;
  if (estimate.mode === 'macResident' && estimate.memoryGB) return <p className="cat-note">{copy.residentNote(estimate.memoryGB)}</p>;
  if (estimate.mode === 'lowRam' && estimate.memoryGB) return <p className="cat-note">{copy.lowRamNote(estimate.memoryGB)} <a href={core.PERFORMANCE_SOURCES.pcFit} target="_blank" rel="noreferrer">MODELS.md<ArrowUpRight size={11}/></a></p>;
  return null;
}

/** Disk the community install adds (its own data folder), shown before the download starts. */
export function CommunityDisk({ model, quant, copy }: { model: CommunityModel; quant: string; copy: CatalogCopy }) {
  const disk = core.communityDiskEstimate(model, quant);
  return <div className="cat-disk" data-testid="community-disk">
    <b>{copy.diskTitle} · {copy.diskExtra(disk.worstGB, disk.bestGB)}</b>
    <p className="cat-note">{copy.diskParts(disk.filesGB, disk.packGB, disk.mtpGB)}</p>
    {disk.officialGB > 0 && <p className="cat-note">{copy.diskReuse(disk.officialGB)}</p>}
  </div>;
}

/** The reasons under the greyed-out official families on a Mac: Metal engine scope, and the installer's qwen-only rule for Unsloth. */
export function MacBlockNotes({ models, platform, copy }: { models: { family: string }[]; platform: RuntimePackagePlatform; copy: CatalogCopy }) {
  const reasons = new Set(models.map(model => core.officialFamilyBlock(model.family, platform)));
  return <>
    {reasons.has('macFamily') && <BlockNote reason="macFamily" source={core.UPSTREAM_MAC_LIMITS_SOURCE} copy={copy}/>}
    {reasons.has('macInstaller') && <p className="cat-block" data-testid="mac-unsloth-installer">{copy.macUnslothInstaller} <a href={core.UPSTREAM_MAC_APP_SOURCE} target="_blank" rel="noreferrer">MAC.md<ArrowUpRight size={11}/></a></p>}
  </>;
}
