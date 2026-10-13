import type { AppLanguage } from "@strata-manager/core";
import type { FloatingMonitorMetric } from '@strata-manager/core';

/** Abbreviate within the metric's stable character budget; keep full values for tooltips. */
export function formatFloatingMonitorValue(value: number | null, metric: FloatingMonitorMetric, language: AppLanguage, compact: boolean, characterBudget = 6) {
  if (value === null || !Number.isFinite(value)) return { text: '—', fullText: '—' };
  const fractionDigits = ['generation', 'prefill', 'vram', 'ram'].includes(metric) ? 1 : 0;
  const fullText = value.toLocaleString(language, { maximumFractionDigits: fractionDigits });
  if (!compact) return { text: fullText, fullText };
  const suffixes = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  const initialScale = Math.min(suffixes.length - 1, Math.max(0, Math.floor(Math.log10(Math.abs(value) || 1) / 3)));
  for (let scale = initialScale; scale < suffixes.length; scale++) {
    const scaled = value / 1000 ** scale;
    for (let precision = scale === 0 ? fractionDigits : 1; precision >= 0; precision--) {
      const numeric = scaled.toLocaleString(language, { maximumFractionDigits: precision, useGrouping: false });
      if (Math.abs(Number(numeric)) >= 1000 && scale < suffixes.length - 1) break;
      const text = `${numeric}${suffixes[scale]}`;
      if (text.length <= characterBudget) return { text, fullText };
    }
  }
  return { text: value.toExponential(0).replace('e+', 'e'), fullText };
}
