import { createContext, useContext } from 'react';
import type { ConcurrencyHardware, ConcurrencyHostOs } from '@strata-manager/core';

/** Where the configuration page runs, for the concurrency card's hardware read. */
export interface ConcurrencyEnvironment { installationId?: string; desktop: boolean; /** Fixtures and previews only: skips the native hardware read. */ hardware?: ConcurrencyHardware | null; platform?: 'mac' | 'other'; /** Engine build of the installation (detected runtimes' runtimeVersion). */ engineVersion?: string; /** Fixtures and previews only: the host OS (else read from the webview's user agent). */ hostOs?: ConcurrencyHostOs }
export const ConcurrencyEnvironmentContext = createContext<ConcurrencyEnvironment>({ desktop: false });
export const useConcurrencyEnvironment = () => useContext(ConcurrencyEnvironmentContext);
