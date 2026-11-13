import { useCallback, useRef, useState } from "react";

import type { ClientCache } from "../cache/cache";
import { CONNECTION_REF, setConnectionRef } from "../cache/keys";
import type { ConnectionRef } from "../cache/types";
import type { Connection, JsonValue } from "../types";
import { filterMap, isRecord } from "../utils";
import { useClient } from "./context";
import { useCacheSubscription } from "./useCacheSubscription";

// A path segment is either a field name (object) or a list index (array).
// Which one depends on the query, not on the cached JSON tree's own type, so
// this dispatches at runtime instead of asserting it.
const readJsonPathSegment = (value: JsonValue, key: PropertyKey): JsonValue => {
  if (Array.isArray(value) && typeof key === "number") {
    return value[key] ?? null;
  }
  if (isRecord(value) && typeof key === "string") {
    return value[key] ?? null;
  }
  return null;
};

// The pages merged by a pagination hook.
type Pages<T> = {
  refs: readonly ConnectionRef[];
  // A connection read from a restored cache (see `Client#restore`) has no
  // connection ref: registration only happens at write time. It is kept as
  // the base page so pages fetched later still merge onto it.
  basePage: T | undefined;
};

const NO_PAGES: Pages<never> = { refs: [], basePage: undefined };

// The pages after `connection` is rendered, or `pages` itself if they don't
// change.
const getNextPages = <T>(
  pages: Pages<T>,
  connection: T,
  cache: ClientCache,
  direction: "after" | "before",
): Pages<T> => {
  if (connection == null) {
    return pages.refs.length === 0 && pages.basePage === undefined
      ? pages
      : NO_PAGES;
  }

  if (typeof connection !== "object" || !(CONNECTION_REF in connection)) {
    return pages.refs.length === 0 && pages.basePage === connection
      ? pages
      : { refs: [], basePage: connection };
  }

  const ref = connection[CONNECTION_REF];

  if (typeof ref !== "object" || ref == null) {
    return pages;
  }

  const info = cache.getCachedConnection(ref);

  // A connection queried without its pagination cursor is a first page.
  // Reset the accumulated references so pages from a previous connection
  // (e.g. another film's characters) don't bleed into this one, and drop the
  // base page: the registered chain covers it.
  if (info == null || info.fieldVariables[direction] == null) {
    return pages.refs.length === 1 &&
      pages.refs[0] === ref &&
      pages.basePage === undefined
      ? pages
      : { refs: [ref], basePage: undefined };
  }

  return pages.refs.includes(ref)
    ? pages
    : { refs: [...pages.refs, ref], basePage: pages.basePage };
};

const createPaginationHook = (direction: "after" | "before") => {
  const isForwardPagination = direction === "after";
  const cursor = isForwardPagination ? "endCursor" : "startCursor";

  return <A, T extends Connection<A>>(connection: T): T => {
    const client = useClient();
    const lastReturnedValueRef = useRef<T[] | undefined>(undefined);

    // Kept in state, not in a ref, so a render that React throws away can't
    // change it. Adjusted during render, so the new pages are read in this
    // render, not one render later.
    const [pages, setPages] = useState<Pages<T>>(NO_PAGES);
    const nextPages = getNextPages(pages, connection, client.cache, direction);

    if (nextPages !== pages) {
      setPages(nextPages);
    }

    const { refs, basePage } = nextPages;

    // Get fresh data from cache
    const readSnapshot = useCallback(
      (watched: Map<object, Set<symbol>>) => {
        const infos = filterMap(refs, (ref) =>
          client.cache.getCachedConnection(ref),
        );

        const queries = filterMap(infos, (info) => {
          const query = client.cache.readOperation(
            info.document,
            info.variables,
            watched,
          );
          return query == null
            ? undefined
            : { query, pathInQuery: info.pathInQuery };
        });

        // If any cached connection couldn't be read, treat the whole thing as a miss
        const allResolved = queries.length === infos.length;

        // Each cache read resolves to `JsonValue`, drilled down to `T` here via
        // the connection's known query path. The result is trusted to match
        // `T`, the shape the caller's typed query declares, the same way any
        // GraphQL response is trusted to match its document's result type.
        const value: T[] | undefined = allResolved
          ? (queries.map(({ query, pathInQuery }) =>
              pathInQuery.reduce(readJsonPathSegment, query),
            ) as T[])
          : undefined;

        const last = lastReturnedValueRef.current;

        // `readOperation` returns referentially stable results, so comparing
        // the page references is enough; a deep walk of every edge is not.
        if (
          value != null &&
          last != null &&
          value.length === last.length &&
          value.every((item, index) => Object.is(item, last[index]))
        ) {
          return last;
        }

        lastReturnedValueRef.current = value;
        return value;
      },
      // `useCacheSubscription` only re-runs a read whose identity (or the
      // cache version) changed. `refs` is a new array whenever the pages
      // change, e.g. when switching to an already-cached connection.
      [client, refs],
    );

    const data = useCacheSubscription(client, readSnapshot);

    if (data == null) {
      return connection;
    }

    const fetched = data.filter((query) => query != null);

    // Prepend the unregistered base page (restored cache), if any. The reduce
    // below deduplicates adjacent pages sharing the same cursor, so a base
    // page that later gets registered isn't counted twice.
    const connections = basePage != null ? [basePage, ...fetched] : fetched;

    if (connections.length === 0) {
      return connection;
    }

    // The merged connection is built from `previous`/`next`, both real `T`
    // instances, but a fresh object literal can't be verified against the
    // generic `T` itself: TypeScript can't confirm a constructed value matches
    // an abstract type parameter, only a concrete one.
    return connections.reduce((previous, next) => {
      if (previous.pageInfo[cursor] === next.pageInfo[cursor]) {
        return previous;
      }

      const start = isForwardPagination ? previous : next;
      const end = isForwardPagination ? next : previous;

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

      // The spread skips the non-enumerable connection ref.
      if (CONNECTION_REF in next) {
        setConnectionRef(merged, next[CONNECTION_REF]);
      }

      return merged;
    });
  };
};

/**
 * Merges later-fetched pages into `connection` as they land in the cache
 * (e.g. after a query re-run with an `after` cursor).
 *
 * @param connection - The connection from your query's result.
 * @returns `connection` unchanged until a next page for the same connection
 * appears in the cache, then the accumulated result with pages joined
 * end-to-end.
 */
export const useForwardPagination = createPaginationHook("after");

/**
 * Same as `useForwardPagination`, but merges pages fetched with a `before`
 * cursor, prepending each new page ahead of `connection`'s edges.
 *
 * @param connection - The connection from your query's result.
 * @returns `connection` unchanged until a next page for the same connection
 * appears in the cache, then the accumulated result with pages joined
 * end-to-end.
 */
export const useBackwardPagination = createPaginationHook("before");
