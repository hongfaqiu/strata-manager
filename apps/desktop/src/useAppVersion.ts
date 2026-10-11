import { useEffect, useState } from 'react';
import { version as bundledVersion } from '../package.json';

/** The installed application is authoritative; browser previews use the build version. */
export function useAppVersion(desktop: boolean) {
  const [version, setVersion] = useState(bundledVersion);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(current => {
      if (!disposed && current.trim()) setVersion(current);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [desktop]);
  return version;
}
