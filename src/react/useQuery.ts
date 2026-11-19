import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { serializeVariables } from "../client/client";
import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
import { useClient } from "./context";
import { useCacheSubscription } from "./useCacheSubscription";
import { usePreviousData } from "./usePreviousData";
import { useStableVariables } from "./useStableVariables";

/** State returned by `useQuery`. */
export type QueryState<Data> = {
  /** `true` while a request is in flight. `data` keeps the previous result. */
  fetching: boolean;
  /** The query result. */
  data: Data;
};

/** `[state, actions]` tuple returned by `useQuery`. */
export type Query<Data, Variables extends AnyVariables> = readonly [
  QueryState<Data>,
  {
    /**
     * Changes some variables and fetches again, without suspending.
     * Used for pagination.
     */
    setVariables: (variables: Partial<Variables>) => void;
    /**
     * Sends the request again. The current data stays visible, with
     * `fetching: true`, until the response arrives.
     */
    refetch: () => void;
  },
];

/**
 * Runs `query` with the `Client` from the nearest `ClientProvider` and keeps
 * the result in sync with the cache.
 *
 * Suspends on the first load of a set of variables. A new `variables` value
 * that is not deeply equal to the previous one loads again and suspends.
 * A failed request throws during render, to the nearest error boundary.
 *
 * @see https://zoontek.github.io/gql-client/queries#usequery
 */
export const useQuery = <Data, Variables extends AnyVariables>(
  query: TypedDocumentNode<Data, Variables>,
  variables: NoInfer<Variables>,
): Query<Data, Variables> => {
  const client = useClient();

  // The document is fixed for the life of the component.
  const [stableQuery] = useState(query);

  const { provided, effective, propsChanged, setVariables } =
    useStableVariables(variables);

  // A rejection caught while old data was shown. It is thrown during render for
  // the nearest ErrorBoundary, but only while the variables match, so a late
  // rejection for older variables is ignored.
  const [error, setError] = useState<
    { key: string; error: ClientError } | undefined
  >(undefined);

  const [isRefetching, setIsRefetching] = useState(false);

  // Identifies the latest `refetch`, so a late response does not change
  // `isRefetching` or `error` for newer variables.
  const latestRefetchIdRef = useRef(0);

  if (propsChanged) {
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

  useEffect(
    () => client.registerQuery(stableQuery, effective),
    [client, stableQuery, effective],
  );

  const needsInitialFetch = data == null;
  const fetching = needsInitialFetch || isRefetching;
  const dataToExpose = data ?? previousData;

  const serializedVariables = serializeVariables(effective);

  if (error != null && error.key === serializedVariables) {
    throw error.error;
  }

  // `client.query` gives one stable promise per document and variables, so a
  // call on each render sends at most one request. This is also true when the
  // cache still misses after the response.
  if (needsInitialFetch) {
    const promise = client.query(stableQuery, effective, {
      suspense: dataToExpose == null,
    });

    // No data to show, so suspend until the first result. Else keep the old
    // data with `fetching: true`, and throw the error on a later render.
    if (dataToExpose == null) {
      use(promise);
    } else {
      promise.catch((queryError: ClientError) => {
        setError({ key: serializedVariables, error: queryError });
      });
    }
  }

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

  const state = useMemo(
    () => ({ fetching, data: dataToExpose as Data }),
    [fetching, dataToExpose],
  );

  const actions = useMemo(
    () => ({ setVariables, refetch }),
    [setVariables, refetch],
  );

  return [state, actions];
};
