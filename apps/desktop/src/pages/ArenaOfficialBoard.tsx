import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import * as core from '@strata-manager/core';
import type { AppLanguage, ArenaOfficialBoard as Board, ArenaOfficialReferenceRow, ArenaOfficialRow, ArenaOfficialSort, ArenaParams, ArenaPayload } from '@strata-manager/core';
import { Empty } from '../components';
import { Dropdown, Segmented } from '../OfficialControls';

type Scope = 'gpu' | 'vram' | 'all';
const gpuLabel = (name: string) => name.replace(/^NVIDIA GeForce |^NVIDIA |^AMD Radeon |^AMD /, '');
const familyName = (family: string) => core.MODEL_CATALOG.find(model => model.family === family)?.name ?? family;
const ctxLabel = (ctx: number) => ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : String(ctx);
const sameParams = (a: ArenaParams, b: ArenaParams) => (['ctx', 'kv', 'gpuCount', 'parallel', 'poolWorkers', 'expertCache', 'pcieFrac', 'vision'] as const).every(key => (a[key] ?? null) === (b[key] ?? null));

/**
 * 「官方基准」 board: official-method (tools/strata_bench.py) results, same model + quant only, ranked by chat decode by default.
 * Published maintainer numbers sit beside the ranked rows as unranked 「官方」 reference rows with their source.
 */
export function ArenaOfficialBoard({ language, active, mine, onUnavailable, onLoaded }: {
  language: AppLanguage; active: boolean; mine?: ArenaPayload;
  /** The server predates /v1/official: the page falls back to the context board. */
  onUnavailable: () => void; onLoaded: (board: Board) => void;
}) {
  const { t } = useTranslation();
  const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits > 0 && value < 100 ? digits : 0 });
  const [group, setGroup] = useState(''), [sort, setSort] = useState<ArenaOfficialSort>('chatDecode'), [scope, setScope] = useState<Scope>('all');
  const [board, setBoard] = useState<Board>(), [error, setError] = useState(false);
  const myGpu = mine?.hw.gpus[0];
  const myGroup = mine ? `${mine.model.family}:${mine.model.quant}` : '';
  useEffect(() => {
    if (!active) return;
    const query = core.arenaOfficialQuery(group || myGroup || null, {}, sort);
    if (scope === 'gpu' && myGpu) query.gpu = myGpu.name;
    if (scope === 'vram' && myGpu) query.vram = String(myGpu.vramGB);
    let current = true;
    void core.arenaGet<Board>('official', query).then(next => {
      if (!current) return;
      setBoard(next); setError(false); onLoaded(next);
      if (!group && next.group) setGroup(next.group);
    }).catch(err => {
      if (!current) return;
      if (core.arenaFailure(err).kind === 'app') onUnavailable(); else setError(true);
    });
    return () => { current = false; };
  }, [active, group, myGroup, sort, scope, myGpu, onUnavailable, onLoaded]);

  const metric = core.arenaOfficialSortMetric(sort) ?? 'chatDecodeTps';
  const digits = metric.startsWith('p') ? 0 : 1;
  type Line = { kind: 'row'; row: ArenaOfficialRow } | { kind: 'ref'; ref: ArenaOfficialReferenceRow };
  /** What a line ranks and draws by: the chosen figure, or the machine count (reference rows have none). */
  const value = (line: Line) => line.kind === 'row' ? (sort === 'machines' ? line.row.machines : line.row.metrics[metric]) : sort === 'machines' ? null : line.ref.metrics[metric];
  const lines = useMemo<Line[]>(() => {
    const all: Line[] = [...(board?.rows ?? []).map(row => ({ kind: 'row' as const, row })), ...(board?.references ?? []).map(ref => ({ kind: 'ref' as const, ref }))];
    return all.sort((a, b) => { const va = value(a), vb = value(b); return va == null || vb == null ? (va == null ? 1 : 0) - (vb == null ? 1 : 0) : vb - va; });
  }, [board, metric, sort]);
  const isMine = (row: ArenaOfficialRow) => !!(mine && myGpu && !row.seed && row.hw.gpu === myGpu.name && sameParams(row.params, mine.params));
  const mineValue = sort === 'machines' ? null : mine?.official?.metrics[metric] ?? null;
  const max = Math.max(1, ...lines.map(line => value(line) ?? 0), mineValue ?? 0);
  const width = (value: number | null) => value == null ? '0%' : `${Math.max(2, value / max * 100).toFixed(1)}%`;
  const chips = (params: ArenaParams) => <span className="arena-params">{[ctxLabel(params.ctx), `KV ${params.kv}`, ...(params.gpuCount > 1 ? [t('arenaGpus', { count: params.gpuCount })] : [])].map(item => <span key={item}>{item}</span>)}</span>;
  const groupOptions = (board?.groups ?? []).map(item => ({ value: item.group, label: `${familyName(item.family)} · ${item.quant}${item.machines ? ' · ' + t('arenaMachines', { count: item.machines }) : ''}` }));
  const scopeOptions = [...(myGpu ? [{ value: 'gpu', label: gpuLabel(myGpu.name) }, { value: 'vram', label: t('arenaVramTier', { gb: myGpu.vramGB }) }] : []), { value: 'all', label: t('arenaAllHardware') }];
  const sorts = core.ARENA_OFFICIAL_SORTS.map(value => ({ value, label: t(`arenaOffSort_${value}`) }));

  if (error) return <Empty title={t('arenaOfflineTitle')} hint={t('arenaOfflineHint')}/>;
  if (!board) return <div className="arena-loading"><LoaderCircle className="spin" size={18}/></div>;
  return <>
    <header className="arena-head">
      <div className="arena-group">{groupOptions.length > 0 && <Dropdown ariaLabel={t('arenaGroup')} value={board.group ?? ''} options={groupOptions} onValueChange={setGroup}/>}</div>
      {myGpu && <Segmented ariaLabel={t('arenaHardware')} value={scope} onValueChange={value => setScope(value as Scope)} options={scopeOptions}/>}
    </header>
    <div className="arena-filterbar"><div className="arena-filter-foot">
      <span className="arena-muted">{t('arenaOfficialCount', { machines: board.groups.find(g => g.group === board.group)?.machines ?? 0, refs: board.references.length })}</span>
      <div className="arena-sort"><Segmented ariaLabel={t('arenaSort')} value={sort} onValueChange={value => setSort(value as ArenaOfficialSort)} options={sorts}/></div>
    </div></div>
    {!lines.length ? <Empty title={t('arenaOfficialEmpty')} hint={t('arenaOfficialEmptyHint')}/> : <ol className="arena-obars">
      {lines.map(line => {
        if (line.kind === 'ref') {
          const ref = line.ref, v = value(line);
          return <li key={ref.id} className="is-ref">
            <span className="arena-rank">—</span>
            <div className="arena-obar-who"><b>{ref.hardware}</b><span className="arena-tag official">{t('arenaOfficialTag')}</span>
              <small className="arena-muted"><a className="arena-link" href={ref.source.url} target="_blank" rel="noopener noreferrer">{ref.source.title}<ArrowUpRight size={11}/></a>{ref.measured.date ? ` · ${ref.measured.date}` : ''}</small></div>
            <div className="arena-obar"><i style={{ width: width(v) }}/></div>
            <span className="arena-value">{v == null ? '—' : <>{ref.printed[metric] ?? number(v, digits)}<small> tok/s</small></>}</span>
          </li>;
        }
        const row = line.row, me = isMine(row), v = value(line);
        return <li key={JSON.stringify([row.hw, row.params, row.seed])} className={me ? 'me' : ''}>
          <span className="arena-rank">{row.rank == null ? '—' : String(row.rank).padStart(2, '0')}</span>
          <div className="arena-obar-who"><b>{gpuLabel(row.hw.gpu)}</b> <span className="arena-muted">{row.hw.vramGB} GB · {t('arenaRam', { gb: row.hw.ramGB })}</span>
            {me && <span className="arena-tag mine">{t('arenaMine')}</span>}{row.seed && <span className="arena-tag">{t('arenaSeed')}</span>}{chips(row.params)}</div>
          <div className="arena-obar" title={t('arenaMachines', { count: row.machines })}><i style={{ width: width(v) }}/>{me && mineValue != null && <b className="you" style={{ left: width(mineValue) }}/>}</div>
          <span className="arena-value">{sort === 'machines' ? row.machines : number(v, digits)}<small>{sort === 'machines' ? '' : ' tok/s'}</small></span>
        </li>;
      })}
    </ol>}
    <p className="arena-foot arena-muted">{t('arenaOfficialFoot')}</p>
  </>;
}
