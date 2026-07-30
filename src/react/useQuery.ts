import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { use, useCallback, useEffect, useRef, useState } from "react";
import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
import { deepEqual } from "../utils";
import { useClient } from "./context";
import { useCacheSubscription } from "./useCacheSubscription";

/**
 * `fetching` is `true` while a request for the current variables is in
 * flight. `data` holds the latest result; while `fetching` is `true` it may
 * still be the previous result, shown until the new one arrives.
 */
export type QueryState<Data> = {
  fetching: boolean;
  data: Data;
};

/** Return type of `useQuery`: a `[state, actions]` tuple. */
export type Query<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = readonly [
  QueryState<Data>,
  {
    /** Patches the query's variables without waiting for new props. */
    setVariables: (variables: Partial<Variables>) => void;
  },
];

const usePreviousData = <T>(
  value: T | undefined,
  resetKey: unknown,
): T | undefined => {
  const previousRef = useRef(value);
  const resetKeyRef = useRef(resetKey);

  // When the reset key changes (new variables passed to the query, as opposed
  // to a `setVariables` call), drop the previous value so the query goes back
  // to its loading state instead of showing the previous result.
  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    previousRef.current = value;
  }

  useEffect(() => {
    if (value !== undefined) {
      previousRef.current = value;
    }
  }, [value]);

  return previousRef.current;
};

type StableVariables<Variables> = {
  // The variables last passed by the caller. Used to detect a prop change and
  // as the reset key for `usePreviousData`.
  provided: Variables;
  // The variables we actually fetch and read with. `setVariables` patches this
  // alone, so a local override survives until the caller passes new variables.
  effective: Variables;
};

/**
 * Runs `query` with `variables` against the `Client` from `ClientProvider`.
 * Suspends (via `use`) while the first result for a given set of variables is
 * loading; on later variable changes it keeps showing the previous data with
 * `fetching: true` instead of suspending again. A request rejection is thrown
 * during render, to be caught by the nearest `ErrorBoundary`.
 */
export const useQuery = <Data, Variables extends AnyVariables = AnyVariables>(
  query: TypedDocumentNode<Data, Variables>,
  variables: NoInfer<Variables>,
): Query<Data, Variables> => {
  const client = useClient();

  // Query should never change
  const [stableQuery] = useState(query);

  const [stableVariables, setStableVariables] = useState<
    StableVariables<Variables>
  >({ provided: variables, effective: variables });

  // A query rejection captured while stale data was shown (the suspending path
  // throws through `use`). It is re-thrown during render so the nearest
  // ErrorBoundary catches it, and cleared whenever the variables change so a
  // retry can run instead of re-throwing a stale error.
  const [error, setError] = useState<ClientError | undefined>(undefined);

  // When the caller passes new (deeply unequal) variables, reset both: the new
  // prop becomes the effective set and any `setVariables` override is dropped.
  // Adjusting state during render (rather than in an effect) makes the new
  // variables take effect on this render; an effect would let one render commit
  // and fetch with the stale variables first. React discards and re-renders on
  // the in-render `setState`, so nothing commits with the old variables.
  const propsChanged = !deepEqual(stableVariables.provided, variables);

  if (propsChanged) {
    setStableVariables({ provided: variables, effective: variables });

    if (error !== undefined) {
      setError(undefined);
    }
  }

  const { provided, effective } = propsChanged
    ? { provided: variables, effective: variables }
    : stableVariables;

  const readSnapshot = useCallback(
    (watched: Map<object, Set<symbol>>) =>
      client.readFromCache(stableQuery, effective, watched),
    [client, stableQuery, effective],
  );

  const data = useCacheSubscription(client, readSnapshot);

  const previousData = usePreviousData(data, provided);

  const fetching = data === undefined;
  const dataToExpose = fetching ? previousData : data;

  const setVariables = useCallback((variables: Partial<Variables>) => {
    setStableVariables((prev) => {
      const effective = { ...prev.effective, ...variables };

      return deepEqual(prev.effective, effective)
        ? prev
        : { provided: prev.provided, effective };
    });
  }, []);

  // Surface a captured query rejection to the nearest ErrorBoundary. Ignore an
  // error captured for the previous variables (`propsChanged` already cleared
  // it from state above) so new variables retry from scratch.
  if (!propsChanged && error !== undefined) {
    throw error;
  }

  // While there's no fresh data for the current variables, (re)issue the
  // request. The client deduplicates in-flight requests, so calling this on
  // every render fires at most one network request per set of variables.
  if (fetching) {
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

  // The cache read resolves to `JsonValue`, trusted to match `Data`, the
  // shape the caller's typed query declares, the same way any GraphQL
  // response is trusted to match its document's result type.
  return [{ fetching, data: dataToExpose as Data }, { setVariables }];
};
