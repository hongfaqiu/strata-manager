import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as core from '@strata-manager/core';

export const SHOW_ALL_VERSIONS_KEY = 'configShowAllVersionsV1';

/** Persisted “Show all versions” preference, shared by every configuration list. */
export function useShowAllVersions(): [boolean, (value: boolean) => void] {
  const client = useQueryClient();
  const key = ['store', SHOW_ALL_VERSIONS_KEY];
  const query = useQuery({ queryKey: key, queryFn: () => core.loadStore<boolean>(SHOW_ALL_VERSIONS_KEY, false).then(value => value === true).catch(() => false), staleTime: Infinity });
  const set = (value: boolean) => { client.setQueryData(key, value); void core.saveStore(SHOW_ALL_VERSIONS_KEY, value).catch(() => undefined); };
  return [query.data === true, set];
}
