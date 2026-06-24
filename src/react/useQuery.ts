import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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

  // When the caller passes new (deeply unequal) variables, reset both: the new
  // prop becomes the effective set and any `setVariables` override is dropped.
  useEffect(() => {
    if (!deepEqual(stableVariables.provided, variables)) {
      setStableVariables({ provided: variables, effective: variables });
    }
  }, [stableVariables, variables]);

  // Get data from cache
  const getSnapshot = useCallback(() => {
    return client.readFromCache(stableQuery, stableVariables.effective);
  }, [client, stableQuery, stableVariables]);

  const data = useSyncExternalStore((fn) => client.subscribe(fn), getSnapshot);

  const previousData = usePreviousData(data, stableVariables.provided);

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

  // While there's no fresh data for the current variables, (re)issue the
  // request. The client deduplicates in-flight requests, so calling this on
  // every render fires at most one network request per set of variables.
  if (fetching) {
    const promise = client.query(stableQuery, stableVariables.effective);

    // With nothing to show yet, suspend until the first result arrives.
    // Otherwise keep showing the previous data with `fetching: true`.
    if (dataToExpose === undefined) {
      use(promise);
    }
  }

  return [{ fetching, data: dataToExpose as Data }, { setVariables }];
};
