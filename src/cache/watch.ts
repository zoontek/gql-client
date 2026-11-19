import { getOrInsert } from "../utils";
import { TYPENAME_KEY } from "./keys";

// The (entry, field) pairs that a read used or a write changed. `undefined`
// matches every write. A subscriber has no set until its first successful read,
// so the write that fills its data still notifies it.
type WatchedEntries = Map<object, Set<symbol>> | undefined;

// A mutable box, so a subscription can get a new set after each read without
// subscribing again.
export type WatchedEntriesBox = { current: WatchedEntries };

export const trackField = (
  watched: Map<object, Set<symbol>> | undefined,
  entry: object,
  field: symbol,
): void => {
  // The `__typename` of an entry never changes. If it was tracked, all reads
  // and writes of the shared root entry would overlap.
  if (watched != null && field !== TYPENAME_KEY) {
    getOrInsert(watched, entry, () => new Set<symbol>()).add(field);
  }
};

export const entriesOverlap = (
  a: WatchedEntries,
  b: WatchedEntries,
): boolean => {
  if (a == null || b == null) {
    return true;
  }

  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];

  for (const [entry, fields] of smaller) {
    const otherFields = larger.get(entry);

    if (otherFields == null) {
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
