import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { WatchedEntriesBox } from "../cache/watch";
import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
import { deepEqual } from "../utils";
import { useClient } from "./context";

export type QueryState<Data> = {
  fetching: boolean;
  data: Data;
};

export type Query<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = readonly [
  QueryState<Data>,
  {
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

  const effective = propsChanged ? variables : stableVariables.effective;
  const provided = propsChanged ? variables : stableVariables.provided;

  // A stable box the client's subscription reads from at notify time. Updated
  // by `getSnapshot` after every read, so the subscription stays scoped to
  // whatever this query actually reads without needing to re-subscribe.
  const [watchedEntries] = useState<WatchedEntriesBox>(() => ({
    current: undefined,
  }));

  // Get data from cache
  const getSnapshot = useCallback(() => {
    const watched = new Map<object, Set<symbol>>();
    const data = client.readFromCache(stableQuery, effective, watched);

    // On a miss, leave the subscription unscoped (matches any write): we don't
    // yet know what this query will end up reading, so we can't narrow it down
    // without risking missing the write that resolves this query's own fetch.
    watchedEntries.current = data === undefined ? undefined : watched;

    return data;
  }, [client, stableQuery, effective, watchedEntries]);

  const subscribe = useCallback(
    (fn: () => void) => client.subscribe(fn, watchedEntries),
    [client, watchedEntries],
  );

  const data = useSyncExternalStore(subscribe, getSnapshot);

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

  return [{ fetching, data: dataToExpose as Data }, { setVariables }];
};
