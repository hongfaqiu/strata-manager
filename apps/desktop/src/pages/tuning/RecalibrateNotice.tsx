import type { AppLanguage } from '@strata-manager/core';
import { RotateCcw } from 'lucide-react';

/** zh/en copy for the "engine upgraded, measure again" notice (upstream #4841). */
export function recalibrateText(language: AppLanguage, from: string, to: string) {
  return language === 'zh-CN' ? {
    title: '引擎已升级，建议重新校准',
    body: `上次校准是在引擎 ${from} 上测的，这个配置现在用的是 ${to}。新引擎会改并发默认值和计算内核，旧的校准结果不一定还准；重新校准会在新引擎上再测一遍，测完照常由你决定是否应用。`,
    start: '重新校准',
    dismiss: '以后再说',
  } : {
    title: 'Engine upgraded: recalibrate',
    body: `The last calibration ran on engine ${from}; this configuration now runs ${to}. Newer engines change parallel defaults and kernels, so the old result may no longer hold. Recalibrating measures again on the new engine; nothing is applied until you choose to.`,
    start: 'Recalibrate',
    dismiss: 'Not now',
  };
}

/** Shown on the tuning page when the latest calibration was measured on an older engine than the configuration now runs. */
export function RecalibrateNotice({ language, from, to, disabled, onStart, onDismiss }: { language: AppLanguage; from: string; to: string; disabled?: boolean; onStart: () => void; onDismiss: () => void }) {
  const text = recalibrateText(language, from, to);
  return <div className="notice warning sb-recalibrate" role="status" data-testid="recalibrate-notice">
    <div><strong>{text.title}</strong><p>{text.body}</p></div>
    <div className="actions"><button type="button" onClick={onDismiss} data-testid="recalibrate-dismiss">{text.dismiss}</button><button type="button" className="primary" disabled={disabled} onClick={onStart} data-testid="recalibrate-start"><RotateCcw size={14}/>{text.start}</button></div>
  </div>;
}
