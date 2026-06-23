import { Option } from "@bloodyowl/boxed";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Connection } from "../types";
import { CONNECTION_REF, deepEqual, filterMap } from "../utils";
import { useClient } from "./context";

const createPaginationHook = (direction: "after" | "before") => {
  const isForwardPagination = direction === "after";
  const cursor = isForwardPagination ? "endCursor" : "startCursor";

  return <A, T extends Connection<A>>(connection: T): T => {
    const client = useClient();
    const connectionRefs = useRef<number[]>([]);
    const lastReturnedValueRef = useRef<Option<T[]>>(Option.None());

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
      const value = Option.all(
        filterMap(connectionRefs.current, (id) =>
          Option.fromNullable(client.getCachedConnection(id)),
        ).flatMap((info) =>
          client
            .readFromCache(info.document, info.variables)
            .map((query) => ({ query, pathInQuery: info.pathInQuery })),
        ),
      ).map((queries) =>
        queries.map(({ query, pathInQuery }) => {
          return pathInQuery.reduce<unknown>(
            (acc, key) =>
              acc != null && typeof acc === "object" && key in acc
                ? (acc as Record<PropertyKey, unknown>)[key]
                : null,
            query,
          );
        }),
      ) as Option<T[]>;
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

    return data
      .flatMap((queries) => {
        const connections = queries.filter((query) => query != null);

        if (connections.length === 0) {
          return Option.None();
        }

        return Option.Some(
          connections.reduce((previous, next) => {
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
          }),
        );
      })
      .getOr(connection as NonNullable<T>) as T;
  };
};

export const useForwardPagination = createPaginationHook("after");
export const useBackwardPagination = createPaginationHook("before");
