import { useCallback, useMemo, useRef, useState } from "react";

import type { ClientCache } from "../cache/cache";
import { CONNECTION_REF, setConnectionRef } from "../cache/keys";
import type { ConnectionRef } from "../cache/types";
import type { Connection, JsonValue } from "../types";
import { isRecord, shallowEqualArrays } from "../utils";
import { useClient } from "./context";
import { useCacheSubscription } from "./useCacheSubscription";

const readJsonPathSegment = (value: JsonValue, key: PropertyKey): JsonValue => {
  if (Array.isArray(value) && typeof key === "number") {
    return value[key] ?? null;
  }
  if (isRecord(value) && typeof key === "string") {
    return value[key] ?? null;
  }
  return null;
};

type Pages<T> = {
  refs: readonly ConnectionRef[];
  // A connection from a restored cache has no ref, because refs are made when a
  // response is written. It is kept as the base page, so later pages merge onto
  // it.
  basePage: T | undefined;
};

const NO_PAGES: Pages<never> = { refs: [], basePage: undefined };

const samePages = <T>(a: Pages<T>, b: Pages<T>): boolean =>
  a.basePage === b.basePage && shallowEqualArrays(a.refs, b.refs);

const getNextPages = <T>(
  pages: Pages<T>,
  connection: T,
  cache: ClientCache,
  direction: "after" | "before",
): Pages<T> => {
  if (connection == null) {
    return NO_PAGES;
  }

  if (typeof connection !== "object" || !(CONNECTION_REF in connection)) {
    return { refs: [], basePage: connection };
  }

  const ref = connection[CONNECTION_REF];

  if (typeof ref !== "object" || ref == null) {
    return pages;
  }

  const info = cache.getConnectionInfo(ref);

  // A connection loaded without its cursor argument is a first page. A new list
  // starts, so the pages of another connection do not stay.
  if (info == null || info.fieldArguments[direction] == null) {
    return { refs: [ref], basePage: undefined };
  }

  return pages.refs.includes(ref)
    ? pages
    : { refs: [...pages.refs, ref], basePage: pages.basePage };
};

const createPaginationHook = (direction: "after" | "before") => {
  const isForward = direction === "after";
  const cursorKey = isForward ? "endCursor" : "startCursor";

  return <A, T extends Connection<A>>(connection: T): T => {
    const client = useClient();
    const lastPagesRef = useRef<T[] | undefined>(undefined);

    // In state, not in a ref, so a render that React discards cannot change it.
    // Updated during render, so this render reads the new pages.
    const [pages, setPages] = useState<Pages<T>>(NO_PAGES);
    const computedPages = getNextPages(
      pages,
      connection,
      client.cache,
      direction,
    );
    const nextPages = samePages(pages, computedPages) ? pages : computedPages;

    if (nextPages !== pages) {
      setPages(nextPages);
    }

    const { refs, basePage } = nextPages;

    const readSnapshot = useCallback(
      (watched: Map<object, Set<symbol>>) => {
        const value: T[] = [];
        let allResolved = true;

        for (const ref of refs) {
          const info = client.cache.getConnectionInfo(ref);

          if (info == null) {
            continue;
          }

          let page: T | undefined;

          for (const { document, variables, path } of info.readers.values()) {
            const query = client.cache.readOperation(
              document,
              variables,
              watched,
            );

            if (query != null) {
              page = path.reduce(readJsonPathSegment, query) as T;
              break;
            }
          }

          if (page === undefined) {
            allResolved = false;
          } else {
            value.push(page);
          }
        }

        if (!allResolved) {
          lastPagesRef.current = undefined;
          return undefined;
        }

        const last = lastPagesRef.current;

        // `readOperation` returns stable references, so a shallow compare is
        // enough.
        if (last != null && shallowEqualArrays(value, last)) {
          return last;
        }

        lastPagesRef.current = value;
        return value;
      },
      [client, refs],
    );

    const data = useCacheSubscription(client, readSnapshot);

    return useMemo(() => {
      if (data == null) {
        return connection;
      }

      const fetched = data.filter((page) => page != null);

      const connections = basePage != null ? [basePage, ...fetched] : fetched;

      if (connections.length === 0) {
        return connection;
      }

      return connections.reduce((previous, next) => {
        // Adjacent pages with the same cursor are the same page, for example a
        // base page that was registered later.
        if (previous.pageInfo[cursorKey] === next.pageInfo[cursorKey]) {
          return previous;
        }

        const start = isForward ? previous : next;
        const end = isForward ? next : previous;

        const merged = {
          ...next,
          edges: [...(start.edges ?? []), ...(end.edges ?? [])],
          pageInfo: {
            startCursor: start.pageInfo.startCursor,
            hasPreviousPage: start.pageInfo.hasPreviousPage,
            endCursor: end.pageInfo.endCursor,
            hasNextPage: end.pageInfo.hasNextPage,
          },
        };

        // The spread skips the non-enumerable ref, so it is copied here. The
        // merged connection gets the ref of the newest page.
        if (CONNECTION_REF in next) {
          setConnectionRef(merged, next[CONNECTION_REF]);
        }

        return merged;
      });
    }, [basePage, connection, data]);
  };
};

/**
 * Takes a connection from a query result and returns it with the edges of
 * the pages fetched after it, in order. Fetch the next page with
 * `setVariables({ after: endCursor })`.
 *
 * @see https://zoontek.github.io/gql-client/pagination
 */
export const useForwardPagination = createPaginationHook("after");

/**
 * Takes a connection from a query result and returns it with the edges of
 * the pages fetched before it, in order. Fetch the previous page with
 * `setVariables({ before: startCursor })`.
 *
 * @see https://zoontek.github.io/gql-client/pagination
 */
export const useBackwardPagination = createPaginationHook("before");
