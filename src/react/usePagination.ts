import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { CONNECTION_REF } from "../cache/keys";
import type { WatchedEntriesBox } from "../cache/watch";
import type { Connection, JsonValue } from "../types";
import { deepEqual, filterMap, isRecord } from "../utils";
import { useClient } from "./context";

// A path segment is either a field name (object) or a list index (array) —
// which one depends on the query, not on anything the cached JSON tree's own
// type can express, so this dispatches at runtime instead of asserting it.
const readJsonPathSegment = (value: JsonValue, key: PropertyKey): JsonValue => {
  if (Array.isArray(value) && typeof key === "number") {
    return value[key] ?? null;
  }
  if (isRecord(value) && typeof key === "string") {
    return value[key] ?? null;
  }
  return null;
};

const createPaginationHook = (direction: "after" | "before") => {
  const isForwardPagination = direction === "after";
  const cursor = isForwardPagination ? "endCursor" : "startCursor";

  return <A, T extends Connection<A>>(connection: T): T => {
    const client = useClient();
    const connectionRefs = useRef<number[]>([]);
    const lastReturnedValueRef = useRef<T[] | undefined>(undefined);

    if (connection == null) {
      connectionRefs.current = [];
    } else if (CONNECTION_REF in connection) {
      const ref = connection[CONNECTION_REF];

      if (typeof ref === "number") {
        const info = client.getCachedConnection(ref);

        // A connection queried without its pagination cursor is a first page.
        // Reset the accumulated references so pages from a previous connection
        // (e.g. another film's characters) don't bleed into this one.
        if (info == null || info.fieldVariables[direction] == null) {
          connectionRefs.current = [ref];
        } else if (!connectionRefs.current.includes(ref)) {
          connectionRefs.current.push(ref);
        }
      }
    }

    // A stable box the client's subscription reads from at notify time. Updated
    // by `getSnapshot` after every read, so the subscription stays scoped to
    // whatever this hook actually reads without needing to re-subscribe.
    const [watchedEntries] = useState<WatchedEntriesBox>(() => ({
      current: undefined,
    }));

    // Get fresh data from cache
    const getSnapshot = useCallback(() => {
      const infos = filterMap(connectionRefs.current, (id) =>
        client.getCachedConnection(id),
      );

      const watched = new Map<object, Set<symbol>>();

      const queries = filterMap(infos, (info) => {
        const query = client.readFromCache(
          info.document,
          info.variables,
          watched,
        );
        return query === undefined
          ? undefined
          : { query, pathInQuery: info.pathInQuery };
      });

      // If any cached connection couldn't be read, treat the whole thing as a miss
      const allResolved = queries.length === infos.length;

      // On a miss, leave the subscription unscoped (matches any write): we
      // don't yet know what this hook will end up reading, so we can't narrow
      // it down without risking missing the write that resolves the miss.
      watchedEntries.current = allResolved ? watched : undefined;

      // Each cache read resolves to `JsonValue`, drilled down to `T` here via
      // the connection's known query path. The result is trusted to match `T`
      // — the shape the caller's typed query declares — the same way any
      // GraphQL response is trusted to match its document's result type.
      const value: T[] | undefined = allResolved
        ? (queries.map(({ query, pathInQuery }) =>
            pathInQuery.reduce(readJsonPathSegment, query),
          ) as T[])
        : undefined;

      if (!deepEqual(value, lastReturnedValueRef.current)) {
        lastReturnedValueRef.current = value;
        return value;
      } else {
        return lastReturnedValueRef.current;
      }
    }, [client, watchedEntries]);

    const data = useSyncExternalStore(
      (fn) => client.subscribe(fn, watchedEntries),
      getSnapshot,
    );

    if (data === undefined) {
      return connection;
    }

    const connections = data.filter((query) => query != null);

    if (connections.length === 0) {
      return connection;
    }

    // The merged connection is built from `previous`/`next`, both real `T`
    // instances, but a fresh object literal can't be verified against the
    // generic `T` itself — TypeScript can't confirm a constructed value matches
    // an abstract type parameter, only a concrete one.
    return connections.reduce((previous, next) => {
      if (previous.pageInfo[cursor] === next.pageInfo[cursor]) {
        return previous;
      }

      const start = isForwardPagination ? previous : next;
      const end = isForwardPagination ? next : previous;

      return {
        ...next,
        edges: [...(start.edges ?? []), ...(end.edges ?? [])],
        pageInfo: {
          startCursor: start.pageInfo.startCursor,
          hasPreviousPage: start.pageInfo.hasPreviousPage,
          endCursor: end.pageInfo.endCursor,
          hasNextPage: end.pageInfo.hasNextPage,
        },
      };
    }) as T;
  };
};

export const useForwardPagination = createPaginationHook("after");
export const useBackwardPagination = createPaginationHook("before");
