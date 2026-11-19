import { useCallback, useRef, useSyncExternalStore } from "react";

import type { WatchedEntriesBox } from "../cache/watch";
import type { Client } from "../client/client";

// After each read, the watched box gets the fields that the read used, so only
// writes to these fields cause a re-render.
export const useCacheSubscription = <T>(
  client: Client,
  read: (watched: Map<object, Set<symbol>>) => T | undefined,
): T | undefined => {
  const watchedEntries = useRef<WatchedEntriesBox["current"]>(undefined);

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

    // The client version changes with each cache change, so the same version
    // gives the same data without a new read.
    if (last != null && last.read === read && last.version === version) {
      return last.data;
    }

    const watched = new Map<object, Set<symbol>>();
    const data = read(watched);

    // On a miss, the read tracked the missing field, so a non-empty set still
    // catches the write that fills it. An empty set (for example, no root entry
    // yet) matches every write.
    watchedEntries.current =
      data == null && watched.size === 0 ? undefined : watched;
    lastSnapshotRef.current = { read, version, data };

    return data;
  }, [client, read, watchedEntries]);

  const subscribe = useCallback(
    (fn: () => void) => client.subscribe(fn, watchedEntries),
    [client, watchedEntries],
  );

  // `getSnapshot` is also the server snapshot, so a server render is a plain
  // cache read. Without it, React throws on the server.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
