import { Option, Result } from "@bloodyowl/boxed";
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
    } else {
      if (
        CONNECTION_REF in connection &&
        typeof connection[CONNECTION_REF] === "number" &&
        !connectionRefs.current.includes(connection[CONNECTION_REF])
      ) {
        connectionRefs.current.push(connection[CONNECTION_REF]);
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
            .map((query) =>
              query.map((query) => ({ query, pathInQuery: info.pathInQuery })),
            ),
        ),
      )
        .map(Result.all)
        .flatMap((x) => x.toOption())
        .map((queries) =>
          queries.map(({ query, pathInQuery }) => {
            return pathInQuery.reduce(
              (acc, key) =>
                acc != null && typeof acc === "object" && key in acc
                  ? // @ts-expect-error indexable
                    acc[key]
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
      .map(([first, ...rest]) =>
        rest.reduce((previous, next) => {
          if (previous == null || next == null) {
            return next;
          }
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
        }, first),
      )
      .getOr(connection) as T;
  };
};

export const useForwardPagination = createPaginationHook("after");
export const useBackwardPagination = createPaginationHook("before");
