import { useCallback, useState, useSyncExternalStore } from "react";
import type { WatchedEntriesBox } from "../cache/watch";
import type { Client } from "../client/client";

// Shared plumbing for a cache-backed React subscription: a stable box the
// client's subscription reads from at notify time, updated after every read
// so the subscription stays scoped to whatever `read` actually touched,
// without needing to re-subscribe. On a miss (`read` returns `undefined`),
// the subscription is left unscoped (matches any write): the caller doesn't
// yet know what it will end up reading, so it can't narrow down without
// risking missing the write that resolves the miss.
export const useCacheSubscription = <T>(
  client: Client,
  read: (watched: Map<object, Set<symbol>>) => T | undefined,
): T | undefined => {
  const [watchedEntries] = useState<WatchedEntriesBox>(() => ({
    current: undefined,
  }));

  const getSnapshot = useCallback(() => {
    const watched = new Map<object, Set<symbol>>();
    const data = read(watched);
    watchedEntries.current = data === undefined ? undefined : watched;
    return data;
  }, [read, watchedEntries]);

  const subscribe = useCallback(
    (fn: () => void) => client.subscribe(fn, watchedEntries),
    [client, watchedEntries],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
};
