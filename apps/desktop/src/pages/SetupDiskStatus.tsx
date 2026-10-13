import { useTranslation } from 'react-i18next';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { SetupDiskPreflight } from '@strata-manager/core';
import './setup-disk.css';

export function SetupDiskStatus({ data, pending, error, onRefresh }: {
  data?: SetupDiskPreflight;
  pending: boolean;
  error?: unknown;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation();
  const size = (value: number | null | undefined) => value == null ? t('unknown')
    : `${(value / 1024 ** 3).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} GiB`;
  return <div className="setup-disk" data-testid="setup-disk">
    <div className="setup-disk-heading"><strong>{t('setupDiskTitle')}</strong><button type="button" className="icon-button" aria-label={t('setupDiskRefresh')} data-tooltip={t('setupDiskRefresh')} disabled={pending} onClick={onRefresh}><RefreshCw size={13}/></button></div>
    {pending && !data ? <p role="status"><LoaderCircle size={14} className="spin"/> {t('setupDiskChecking')}</p>
      : error ? <p className="setup-disk-error" role="alert">{t('setupDiskUnknown')}<small>{String(error)}</small></p>
      : data && <>
        <dl><div><dt>{t('setupDiskAdditional')}</dt><dd>{size(data.additionalBytesEstimate)}</dd></div>
          {data.reusableModelBytes > 0 && <div><dt>{t('setupDiskReused')}</dt><dd>{size(data.reusableModelBytes)}</dd></div>}
        </dl>
        <p className="setup-disk-path" data-tooltip={data.dataDirectory}><span>{t('setupDiskDirectory')}</span><code>{data.dataDirectory}</code></p>
        {data.volumes.map((volume, index) => <p className="setup-disk-volume" key={`${volume.mountPoint ?? volume.directory}-${index}`}><code data-tooltip={volume.directory}>{volume.mountPoint ?? volume.directory}</code><span>{t('setupDiskAvailable', { available: size(volume.availableBytes), required: size(volume.requiredAdditionalBytesEstimate) })}</span></p>)}
        {data.status !== 'ready' && <p className="setup-disk-error" role="alert">{t(data.status === 'insufficient' ? 'setupDiskInsufficient' : 'setupDiskUnknown')}</p>}
        <details><summary>{t('setupDiskEstimateHint')}</summary><p>{t('setupDiskEstimateScope')}</p>{data.status !== 'ready' && <p>{data.reason}</p>}</details>
      </>}
  </div>;
}
