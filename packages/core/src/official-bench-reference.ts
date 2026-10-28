/** Published strata_bench.py numbers (official-bench-reference.json) and how a local report is matched against them. */
import { arenaOfficialModelKey } from './arena';
import type { OfficialBenchMachine, OfficialBenchReport, OfficialMetricKey, OfficialStat } from './official-bench';
import { officialSummary } from './official-bench';
import data from './official-bench-reference.json';

/** A published figure: a median, a range, or both; `approx` marks values the source prints with "about". */
/** `printed` keeps the source's digits where JSON would drop them ("44.0", "0.60"). */
export interface OfficialValue { median?: number; min?: number; max?: number; approx?: boolean; printed?: string }
export interface OfficialReference {
  id: string;
  hardware: { label: string; match: string; detail: string };
  model: { label: string; family: string; quant: string };
  setup: string;
  measured: { date: string | null; strata: string; command: string };
  source: { title: string; url: string };
  metrics: Partial<Record<OfficialMetricKey, OfficialValue>>;
  notes?: string[];
  extraSources?: { title: string; url: string }[];
}
export const OFFICIAL_REFERENCES: readonly OfficialReference[] = data.references as OfficialReference[];
export const OFFICIAL_REFERENCE_COMMIT: string = data.upstreamCommit;

export interface OfficialModelKey { family: string; quant: string | null }
/** Family and quant from the served model name, file names and launch parameters (never paths). */
export function officialModelKey(evidence: readonly string[]): OfficialModelKey | null {
  return arenaOfficialModelKey(evidence.filter(Boolean).join(' '));
}

export function officialHardwareMatches(reference: OfficialReference, machine: Pick<OfficialBenchMachine, 'gpuNames' | 'cpuName'>): boolean {
  const pattern = new RegExp(reference.hardware.match, 'i');
  return [...machine.gpuNames, machine.cpuName ?? ''].some(name => pattern.test(name));
}

export interface OfficialMatch { reference: OfficialReference | null; model: OfficialModelKey | null; hardwareKnown: boolean }
/** The published row for the same hardware, model family and quant, or none. Nothing is matched by approximation. */
export function matchOfficialReference(machine: OfficialBenchMachine, references: readonly OfficialReference[] = OFFICIAL_REFERENCES): OfficialMatch {
  const model = officialModelKey(machine.modelEvidence);
  const hardwareKnown = references.some(ref => officialHardwareMatches(ref, machine));
  const reference = model?.quant ? references.find(ref => ref.model.family === model.family && ref.model.quant.toUpperCase() === model.quant!.toUpperCase() && officialHardwareMatches(ref, machine)) ?? null : null;
  return { reference, model, hardwareKnown };
}

export interface OfficialComparisonRow {
  key: OfficialMetricKey; higherBetter: boolean; unit: 'tok/s' | 's' | '%';
  /** The value the bars use: the published median, else the middle of the published range (`officialIsRange`). */
  official: number | null; officialValue: OfficialValue | null; officialIsRange: boolean;
  yours: number | null; yoursStat: OfficialStat | null; relative: number | null; improved: boolean | null;
}
export const OFFICIAL_METRIC_ORDER: readonly { key: OfficialMetricKey; unit: OfficialComparisonRow['unit']; higherBetter: boolean }[] = [
  { key: 'chatDecodeTps', unit: 'tok/s', higherBetter: true }, { key: 'chatTtftS', unit: 's', higherBetter: false },
  { key: 'p4kTps', unit: 'tok/s', higherBetter: true }, { key: 'p4kTtftS', unit: 's', higherBetter: false },
  { key: 'p16kTps', unit: 'tok/s', higherBetter: true }, { key: 'p16kTtftS', unit: 's', higherBetter: false },
  { key: 'p32kTps', unit: 'tok/s', higherBetter: true }, { key: 'p32kTtftS', unit: 's', higherBetter: false },
  { key: 'agentHitPct', unit: '%', higherBetter: true }, { key: 'agentDecodeTps', unit: 'tok/s', higherBetter: true }, { key: 'agentTurnTtftS', unit: 's', higherBetter: false },
];

export function officialPoint(value: OfficialValue | undefined | null): { value: number | null; isRange: boolean } {
  if (!value) return { value: null, isRange: false };
  if (typeof value.median === 'number') return { value: value.median, isRange: false };
  if (typeof value.min === 'number' && typeof value.max === 'number') return { value: (value.min + value.max) / 2, isRange: true };
  return { value: null, isRange: false };
}

/** One row per metric either side has; "yours" is the report's median. Relative change is yours vs official. */
export function officialComparisonRows(report: OfficialBenchReport, reference: OfficialReference | null): OfficialComparisonRow[] {
  const summary = officialSummary(report.results);
  return OFFICIAL_METRIC_ORDER.flatMap(({ key, unit, higherBetter }) => {
    const ov = reference?.metrics[key] ?? null, yoursStat = summary[key] ?? null;
    if (!ov && !yoursStat) return [];
    const point = officialPoint(ov), yours = yoursStat?.median ?? null;
    const absolute = point.value === null || yours === null ? null : yours - point.value;
    const relative = absolute === null || point.value === 0 ? null : absolute / point.value!;
    const improved = absolute === null || absolute === 0 ? null : higherBetter ? absolute > 0 : absolute < 0;
    return [{ key, unit, higherBetter, official: point.value, officialValue: ov, officialIsRange: point.isRange, yours, yoursStat, relative, improved }];
  });
}
