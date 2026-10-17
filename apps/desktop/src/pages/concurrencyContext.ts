import { createContext, useContext } from 'react';

/** Where the configuration page runs, for the concurrency card's hardware read. */
export interface ConcurrencyEnvironment { installationId?: string; desktop: boolean }
export const ConcurrencyEnvironmentContext = createContext<ConcurrencyEnvironment>({ desktop: false });
export const useConcurrencyEnvironment = () => useContext(ConcurrencyEnvironmentContext);
