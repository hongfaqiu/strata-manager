import { useEffect, useState } from 'react';
import { serverBootstrap } from '@strata-manager/core';
import { version as bundledVersion } from '../package.json';

/** The installed application is authoritative; browser / server panel use build or bootstrap version. */
export function useAppVersion(tauriShell: boolean) {
  const boot = serverBootstrap()?.version?.trim();
  const [version, setVersion] = useState(boot || bundledVersion);
  useEffect(() => {
    if (!tauriShell) {
      const next = serverBootstrap()?.version?.trim() || bundledVersion;
      setVersion(next);
      return;
    }
    let disposed = false;
    void import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(current => {
      if (!disposed && current.trim()) setVersion(current);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [tauriShell]);
  return version;
}
