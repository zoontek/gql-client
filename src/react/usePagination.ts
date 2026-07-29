import { useCallback, useRef, useSyncExternalStore } from "react";
import { CONNECTION_REF } from "../cache/keys";
import type { Connection, JsonValue } from "../types";
import { deepEqual, filterMap } from "../utils";
import { useClient } from "./context";

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

    // Get fresh data from cache
    const getSnapshot = useCallback(() => {
      const infos = filterMap(connectionRefs.current, (id) =>
        client.getCachedConnection(id),
      );

      const queries = filterMap(infos, (info) => {
        const query = client.readFromCache(info.document, info.variables);
        return query === undefined
          ? undefined
          : { query, pathInQuery: info.pathInQuery };
      });

      // If any cached connection couldn't be read, treat the whole thing as a miss
      const value: T[] | undefined =
        queries.length === infos.length
          ? (queries.map(({ query, pathInQuery }) =>
              pathInQuery.reduce<JsonValue>(
                (acc, key) =>
                  acc != null && typeof acc === "object" && key in acc
                    ? ((acc as Record<PropertyKey, JsonValue>)[key] ?? null)
                    : null,
                query,
              ),
            ) as T[])
          : undefined;

      if (!deepEqual(value, lastReturnedValueRef.current)) {
        lastReturnedValueRef.current = value;
        return value;
      } else {
        return lastReturnedValueRef.current;
      }
    }, [client]);

    const data = useSyncExternalStore(
      (fn) => client.subscribe(fn),
      getSnapshot,
    );

    if (data === undefined) {
      return connection as T;
    }

    const connections = data.filter((query) => query != null);

    if (connections.length === 0) {
      return connection as T;
    }

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
