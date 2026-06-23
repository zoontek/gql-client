import type { Option } from "@bloodyowl/boxed";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ClientError } from "../errors";
import type { AnyVariables } from "../types";
import { deepEqual } from "../utils";
import { useClient } from "./context";

export type QueryState<Data> =
  | { fetching: boolean }
  | { fetching: boolean; data: Data }
  | { fetching: boolean; error: ClientError };

export type Query<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = readonly [
  QueryState<Data>,
  {
    setVariables: (variables: Partial<Variables>) => void;
  },
];

const usePreviousData = <T>(value: Option<T>, resetKey: unknown): Option<T> => {
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
    if (value.isSome()) {
      previousRef.current = value;
    }
  }, [value]);

  return previousRef.current;
};

export const useQuery = <Data, Variables extends AnyVariables = AnyVariables>(
  query: TypedDocumentNode<Data, Variables>,
  variables: NoInfer<Variables>,
): Query<Data, Variables> => {
  const client = useClient();

  // Query should never change
  const [stableQuery] = useState(query);

  // Only break variables reference equality if not deeply equal
  const [stableVariables, setStableVariables] = useState<
    [Variables, Variables]
  >([variables, variables]);

  useEffect(() => {
    const [providedVariables] = stableVariables;

    if (!deepEqual(providedVariables, variables)) {
      setStableVariables([variables, variables]);
    }
  }, [stableVariables, variables]);

  // Get data from cache
  const getSnapshot = useCallback(() => {
    return client.readFromCache(stableQuery, stableVariables[1]);
  }, [client, stableQuery, stableVariables]);

  const data = useSyncExternalStore((fn) => client.subscribe(fn), getSnapshot);

  const previousData = usePreviousData(data, stableVariables[0]);

  useEffect(() => {
    client.request(stableQuery, stableVariables[1]);
  }, [client, stableQuery, stableVariables]);

  const fetching = data.isNone();
  const dataToExpose = fetching ? previousData : data;

  const state = useMemo<QueryState<Data>>(() => {
    return dataToExpose.match({
      Some: (value) => ({ fetching, data: value as Data }),
      None: () => ({ fetching }),
    });
  }, [dataToExpose, fetching]);

  const setVariables = useCallback((variables: Partial<Variables>) => {
    setStableVariables((prev) => {
      const [prevStable, prevFinal] = prev;

      const nextFinal = {
        ...prevFinal,
        ...variables,
      };

      if (!deepEqual(prevFinal, nextFinal)) {
        return [prevStable, nextFinal];
      } else {
        return prev;
      }
    });
  }, []);

  return [state, { setVariables }];
};
