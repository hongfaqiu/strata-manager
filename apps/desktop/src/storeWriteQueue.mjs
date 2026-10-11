/** Immutable React snapshots; at most one write per key, with the latest value
 * following any older in-flight write. Failed snapshots remain pending. */
export function createLatestStoreWriter(write) {
  const entries = new Map();
  const entryFor = key => {
    if (!entries.has(key)) entries.set(key, { desired: undefined, requested: undefined, saved: undefined, staged: false, hasSaved: false, inFlight: undefined });
    return entries.get(key);
  };
  const stage = (key, value) => { const entry = entryFor(key); entry.desired = value; entry.staged = true; };
  const seed = (key, value) => { const entry = entryFor(key); if (entry.inFlight) throw Error('Cannot seed an active store writer'); entry.desired = entry.saved = value; entry.staged = entry.hasSaved = true; };
  const flush = key => {
    const entry = entryFor(key);
    if (entry.staged) entry.requested = entry.desired;
    if (entry.inFlight) return entry.inFlight;
    if (!entry.staged || entry.hasSaved && Object.is(entry.saved, entry.desired)) return Promise.resolve();
    entry.inFlight = Promise.resolve().then(async () => {
      try {
        while (!entry.hasSaved || !Object.is(entry.saved, entry.requested)) {
          const snapshot = entry.requested;
          await write(key, snapshot);
          entry.saved = snapshot; entry.hasSaved = true;
        }
      } finally { entry.inFlight = undefined; }
    });
    return entry.inFlight;
  };
  const flushAll = async () => {
    const results = await Promise.allSettled([...entries.keys()].map(flush));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  return { stage, seed, flush, flushAll };
}
