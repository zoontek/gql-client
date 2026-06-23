import { AsyncData, Result } from "@bloodyowl/boxed";
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

export type Query<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = readonly [
  AsyncData<Result<Data, ClientError>>,
  {
    fetching: boolean;
    setVariables: (variables: Partial<Variables>) => void;
  },
];

const usePreviousValue = <A, T extends AsyncData<A>>(value: T): T => {
  const previousRef = useRef(value);

  useEffect(() => {
    if (value.isDone()) {
      previousRef.current = value;
    }
    if (value.isLoading() && previousRef.current.isNotAsked()) {
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

  const asyncData = useMemo(() => {
    return data
      .map((value) => AsyncData.Done(value as Result<Data, ClientError>))
      .getOr(AsyncData.Loading());
  }, [data]);

  const previousAsyncData = usePreviousValue(asyncData);

  useEffect(() => {
    const request = client.request(stableQuery, stableVariables[1]);

    return (): void => {
      request.cancel();
    };
  }, [client, stableQuery, stableVariables]);

  const fetching = asyncData.isLoading();
  const asyncDataToExpose = fetching ? previousAsyncData : asyncData;

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

  return [asyncDataToExpose, { fetching, setVariables }];
};
