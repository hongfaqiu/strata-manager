import { createContext, useContext } from 'react';
import type { ConcurrencyHardware } from '@strata-manager/core';

/** Where the configuration page runs, for the concurrency card's hardware read. */
export interface ConcurrencyEnvironment { installationId?: string; desktop: boolean; /** Fixtures and previews only: skips the native hardware read. */ hardware?: ConcurrencyHardware | null; platform?: 'mac' | 'other' }
export const ConcurrencyEnvironmentContext = createContext<ConcurrencyEnvironment>({ desktop: false });
export const useConcurrencyEnvironment = () => useContext(ConcurrencyEnvironmentContext);
