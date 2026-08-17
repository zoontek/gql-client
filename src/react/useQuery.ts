import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { use, useCallback, useEffect, useRef, useState } from "react";

import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
import { serializeVariables } from "../utils";
import { useClient } from "./context";
import { useCacheSubscription } from "./useCacheSubscription";
import { usePreviousData } from "./usePreviousData";
import { useStableVariables } from "./useStableVariables";

/**
 * `fetching` is `true` while a request for the current variables is in
 * flight, whether the automatic fetch on mount/variable change or an
 * explicit `refetch()` call. `data` holds the latest result; while
 * `fetching` is `true` it may still be the previous result, shown until the
 * new one arrives.
 */
export type QueryState<Data> = {
  fetching: boolean;
  data: Data;
};

/** Return type of `useQuery`: a `[state, actions]` tuple. */
export type Query<Data, Variables extends AnyVariables> = readonly [
  QueryState<Data>,
  {
    /** Patches the query's variables without waiting for new props. */
    setVariables: (variables: Partial<Variables>) => void;
    /** Re-sends the request for the current variables. */
    refetch: () => void;
  },
];

/**
 * Runs `query` with `variables` against the `Client` from `ClientProvider`.
 * Suspends (via `use`) while the first result for a given set of variables is
 * loading; on later variable changes it keeps showing the previous data with
 * `fetching: true` instead of suspending again. A request rejection is thrown
 * during render, to be caught by the nearest `ErrorBoundary`.
 *
 * @param query - The query document to run.
 * @param variables - The query's variables.
 * @returns A `[state, actions]` tuple; see `Query`.
 */
export const useQuery = <Data, Variables extends AnyVariables>(
  query: TypedDocumentNode<Data, Variables>,
  variables: NoInfer<Variables>,
): Query<Data, Variables> => {
  const client = useClient();

  // Query should never change
  const [stableQuery] = useState(query);

  const { provided, effective, propsChanged, setVariables } =
    useStableVariables(variables);

  // A query rejection captured while stale data was shown (the suspending path
  // throws through `use`). It is re-thrown during render so the nearest
  // ErrorBoundary catches it. The serialized variables the failed request was
  // sent with are kept alongside, and the error is only thrown while they
  // still match: a late rejection from an abandoned request (older props or
  // an older `setVariables` patch) must not surface for the current ones.
  const [error, setError] = useState<
    { key: string; error: ClientError } | undefined
  >(undefined);

  // True while an explicit `refetch()` call is in flight. The automatic fetch
  // below is already reflected in `fetching` through cache presence (there's
  // nothing to read yet), but a `refetch()` fires even though the cache
  // already has data, so it needs its own flag.
  const [isRefetching, setIsRefetching] = useState(false);

  // Identifies the most recent `refetch` call, so a stale response can't
  // clobber `isRefetching`/`error` after the variables have moved on.
  const latestRefetchIdRef = useRef(0);

  if (propsChanged) {
    // Any `refetch()` still in flight belonged to the old variables: let its
    // eventual response no-op instead of touching state for the new ones.
    latestRefetchIdRef.current++;

    if (error != null) {
      setError(undefined);
    }
    if (isRefetching) {
      setIsRefetching(false);
    }
  }

  const readSnapshot = useCallback(
    (watched: Map<object, Set<symbol>>) =>
      client.cache.readOperation(stableQuery, effective, watched),
    [client, stableQuery, effective],
  );

  const data = useCacheSubscription(client, readSnapshot);

  const previousData = usePreviousData(data, provided);

  // Register the mounted query so `Client#refetch` can re-send it.
  useEffect(
    () => client.registerQuery(stableQuery, effective),
    [client, stableQuery, effective],
  );

  // Whether the cache has nothing yet for the current variables. Drives the
  // automatic fetch/suspend below; kept separate from `isRefetching` so a
  // `refetch()` doesn't cause that block to issue a second, redundant request.
  const needsInitialFetch = data == null;
  const fetching = needsInitialFetch || isRefetching;
  const dataToExpose = data ?? previousData;

  const serializedVariables = serializeVariables(effective);

  // Surface a captured query rejection to the nearest ErrorBoundary, but only
  // when it belongs to the current variables, so newer variables retry from
  // scratch instead of re-throwing a stale error.
  if (error != null && error.key === serializedVariables) {
    throw error.error;
  }

  // While there's no data at all for the current variables, read through the
  // client's request store. It hands out one stable promise per (document,
  // variables), in flight or settled, so calling this on every render fires
  // at most one network request per set of variables, even when a response
  // was written but the cache read still misses.
  if (needsInitialFetch) {
    const promise = client.query(stableQuery, effective);

    if (dataToExpose == null) {
      // Nothing to show yet: suspend until the first result, and let a
      // rejection throw straight through to the ErrorBoundary.
      use(promise);
    } else {
      // Keep showing the previous data with `fetching: true`. We can't `use`
      // the promise (it would suspend away the stale data), so capture a
      // rejection into state; the re-render then throws it (above). The key
      // is captured here, so a rejection landing after the variables moved on
      // is kept but never thrown.
      promise.catch((queryError: ClientError) => {
        setError({ key: serializedVariables, error: queryError });
      });
    }
  }

  // Forces a fresh request even though the cache already has data for the
  // current variables, exposing `fetching: true` for its duration while
  // still showing the cached data underneath. A rejection is captured and
  // thrown on the next render, same as the automatic fetch above.
  const refetch = useCallback(() => {
    const callId = ++latestRefetchIdRef.current;
    const key = serializeVariables(effective);
    setIsRefetching(true);

    client.query(stableQuery, effective, { refresh: true }).then(
      () => {
        if (latestRefetchIdRef.current === callId) {
          setIsRefetching(false);
        }
      },
      (queryError: ClientError) => {
        if (latestRefetchIdRef.current === callId) {
          setIsRefetching(false);
          setError({ key, error: queryError });
        }
      },
    );
  }, [client, stableQuery, effective]);

  // The cache read resolves to `JsonValue`, trusted to match `Data`, the
  // shape the caller's typed query declares, the same way any GraphQL
  // response is trusted to match its document's result type.
  return [
    { fetching, data: dataToExpose as Data },
    { setVariables, refetch },
  ];
};
