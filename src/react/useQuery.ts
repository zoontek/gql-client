import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { use, useCallback, useRef, useState } from "react";

import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
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
  // ErrorBoundary catches it, and cleared whenever the variables change so a
  // retry can run instead of re-throwing a stale error.
  const [error, setError] = useState<ClientError | undefined>(undefined);

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

    if (error !== undefined) {
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

  // Whether the cache has nothing yet for the current variables. Drives the
  // automatic fetch/suspend below; kept separate from `isRefetching` so a
  // `refetch()` doesn't cause that block to issue a second, redundant request.
  const needsInitialFetch = data === undefined;
  const fetching = needsInitialFetch || isRefetching;
  const dataToExpose = data ?? previousData;

  // Surface a captured query rejection to the nearest ErrorBoundary. Ignore an
  // error captured for the previous variables (`propsChanged` already cleared
  // it from state above) so new variables retry from scratch.
  if (!propsChanged && error !== undefined) {
    throw error;
  }

  // While there's no data at all for the current variables, (re)issue the
  // request. The client deduplicates in-flight requests, so calling this on
  // every render fires at most one network request per set of variables.
  if (needsInitialFetch) {
    const promise = client.query(stableQuery, effective);

    if (dataToExpose === undefined) {
      // Nothing to show yet: suspend until the first result, and let a
      // rejection throw straight through to the ErrorBoundary.
      use(promise);
    } else {
      // Keep showing the previous data with `fetching: true`. We can't `use`
      // the promise (it would suspend away the stale data), so capture a
      // rejection into state; the re-render then throws it (above).
      promise.catch((queryError: ClientError) => setError(queryError));
    }
  }

  // Forces a fresh request even though the cache already has data for the
  // current variables, exposing `fetching: true` for its duration while
  // still showing the cached data underneath. A rejection is captured and
  // thrown on the next render, same as the automatic fetch above.
  const refetch = useCallback(() => {
    const callId = ++latestRefetchIdRef.current;
    setIsRefetching(true);

    client.query(stableQuery, effective).then(
      () => {
        if (latestRefetchIdRef.current === callId) {
          setIsRefetching(false);
        }
      },
      (queryError: ClientError) => {
        if (latestRefetchIdRef.current === callId) {
          setIsRefetching(false);
          setError(queryError);
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
