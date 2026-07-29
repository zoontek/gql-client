// Tracks which (cache entry, field) pairs a read touched, or which a write
// modified. `object` (not `CacheEntry`) is used as the map key so this module
// stays decoupled from the cache's internal entry shape — only identity
// matters here.
//
// `undefined` means "unscoped": matches any write. A subscriber uses this
// while it has no successful read yet (initial fetch, or refetching variables
// that aren't cached), so its own eventual write is guaranteed to wake it up,
// exactly like the previous global-notify behavior. Once a read succeeds, the
// subscriber switches to the precise field-level set below.
export type WatchedEntries = Map<object, Set<symbol>> | undefined;

// A mutable box so a subscription (registered once) can be updated with a
// fresh watched set after every read, without re-subscribing.
export type WatchedEntriesBox = { current: WatchedEntries };

export const trackField = (
  watched: Map<object, Set<symbol>>,
  entry: object,
  field: symbol,
): void => {
  let fields = watched.get(entry);

  if (fields === undefined) {
    fields = new Set();
    watched.set(entry, fields);
  }

  fields.add(field);
};

export const entriesOverlap = (
  a: WatchedEntries,
  b: WatchedEntries,
): boolean => {
  if (a === undefined || b === undefined) {
    return true;
  }

  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];

  for (const [entry, fields] of smaller) {
    const otherFields = larger.get(entry);

    if (otherFields === undefined) {
      continue;
    }

    for (const field of fields) {
      if (otherFields.has(field)) {
        return true;
      }
    }
  }

  return false;
};
