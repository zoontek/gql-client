import { TYPENAME_KEY } from "./keys";

// Tracks which (cache entry, field) pairs a read touched, or a write
// modified. The key is `object`, not `CacheEntry`, so this module doesn't
// need to know the cache's internal entry shape, only its identity.
//
// `undefined` means "unscoped", matching any write. A subscriber stays
// unscoped until it has a successful read (first fetch, or refetching
// variables not yet cached), so its own eventual write still wakes it up.
// Once a read succeeds, it switches to the precise field-level set below.
export type WatchedEntries = Map<object, Set<symbol>> | undefined;

// A mutable box so a subscription (registered once) can be updated with a
// fresh watched set after every read, without re-subscribing.
export type WatchedEntriesBox = { current: WatchedEntries };

export const trackField = (
  watched: Map<object, Set<symbol>>,
  entry: object,
  field: symbol,
): void => {
  // `transformDocument` injects `__typename` into every selection set,
  // including the operation root. Tracking it would make every read/write on
  // the shared Query/Mutation root look dependent on every other one, since
  // it never changes for an existing entry there is nothing to invalidate.
  if (field === TYPENAME_KEY) {
    return;
  }

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
