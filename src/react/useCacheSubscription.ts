import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import type { WatchedEntriesBox } from "../cache/watch";
import type { Client } from "../client/client";

// Shared logic for a cache-backed React subscription: a stable box the
// client's subscription reads from at notify time, updated after every read
// so the subscription stays scoped to whatever `read` actually touched,
// without needing to re-subscribe.
//
// On a miss (`read` returns `undefined`), the partial watched set is kept
// when it is non-empty: the read path tracks the missing field itself before
// bailing (see read.ts), so the write that resolves the miss overlaps with
// it. An empty set (nothing could be read at all, e.g. the root entry does
// not exist yet) falls back to unscoped, matching any write.
export const useCacheSubscription = <T>(
  client: Client,
  read: (watched: Map<object, Set<symbol>>) => T | undefined,
): T | undefined => {
  const [watchedEntries] = useState<WatchedEntriesBox>(() => ({
    current: undefined,
  }));

  // The client bumps its version on every cache-affecting event, so a
  // snapshot taken at the current version can be returned as-is instead of
  // re-running the full cache traversal on every render.
  const lastSnapshotRef = useRef<
    | {
        read: (watched: Map<object, Set<symbol>>) => T | undefined;
        version: number;
        data: T | undefined;
      }
    | undefined
  >(undefined);

  const getSnapshot = useCallback(() => {
    const version = client.getVersion();
    const last = lastSnapshotRef.current;

    if (last != null && last.read === read && last.version === version) {
      return last.data;
    }

    const watched = new Map<object, Set<symbol>>();
    const data = read(watched);

    watchedEntries.current =
      data == null && watched.size === 0 ? undefined : watched;
    lastSnapshotRef.current = { read, version, data };

    return data;
  }, [client, read, watchedEntries]);

  const subscribe = useCallback(
    (fn: () => void) => client.subscribe(fn, watchedEntries),
    [client, watchedEntries],
  );

  // `getSnapshot` doubles as the server snapshot: on the server there are no
  // subscriptions, so a server render is a plain cache read (of data the
  // caller prefetched into the client). Without a server snapshot, React
  // throws on any server render.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
