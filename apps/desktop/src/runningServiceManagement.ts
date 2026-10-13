import { normalizeError } from '@strata-manager/core';

/** A running Manager-owned service is reconnected, never migrated by fallback. */
export async function manageRunningService<T>(connect: () => Promise<T>, manage: () => Promise<T>): Promise<T> {
  try { return await connect(); }
  catch (error) {
    if (normalizeError(error).code !== 'RUNNING_OWNER_NOT_FOUND') throw error;
    return manage();
  }
}
