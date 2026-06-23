import { AsyncData, Result } from "@bloodyowl/boxed";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ClientError } from "../errors";
import type { TypedDocumentNode } from "../types";
import { deepEqual } from "../utils";
import { ClientContext } from "./ClientContext";

export type Query<Data, Variables> = readonly [
  AsyncData<Result<Data, ClientError>>,
  {
    isLoading: boolean;
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

export const useQuery = <Data, Variables>(
  query: TypedDocumentNode<Data, Variables>,
  variables: NoInfer<Variables>,
): Query<Data, Variables> => {
  const client = useContext(ClientContext);

  // Query should never change
  const [stableQuery] = useState<TypedDocumentNode<Data, Variables>>(query);

  // Only break variables reference equality if not deeply equal
  const [stableVariables, setStableVariables] = useState<
    [Variables, Variables]
  >([variables, variables]);

  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    const [providedVariables] = stableVariables;

    if (!deepEqual(providedVariables, variables)) {
      setIsReloading(true);
      setStableVariables([variables, variables]);
    }
  }, [stableVariables, variables]);

  // Get data from cache
  const getSnapshot = useCallback(() => {
    return client.readFromCache(stableQuery, stableVariables[1]);
  }, [client, stableQuery, stableVariables]);

  const data = useSyncExternalStore(
    (func) => client.subscribe(func),
    getSnapshot,
  );

  const asyncData = useMemo(() => {
    return data
      .map((value) => AsyncData.Done(value as Result<Data, ClientError>))
      .getOr(AsyncData.Loading());
  }, [data]);

  const previousAsyncData = usePreviousValue(asyncData);
  const isSuspenseFirstFetch = useRef(true);
  const isLoading = isReloading || asyncData.isLoading();

  useEffect(() => {
    if (isSuspenseFirstFetch.current) {
      isSuspenseFirstFetch.current = false;
      return;
    }
    const request = client
      .request(stableQuery, stableVariables[1])
      .tap(() => setIsReloading(false));

    return (): void => {
      request.cancel();
    };
  }, [client, stableQuery, stableVariables]);

  const asyncDataToExpose = isReloading
    ? AsyncData.Loading()
    : isLoading
      ? previousAsyncData
      : asyncData;

  if (isSuspenseFirstFetch.current && asyncDataToExpose.isLoading()) {
    throw client.request(stableQuery, stableVariables[1]).toPromise();
  }

  const setVariables = useCallback((variables: Partial<Variables>) => {
    setStableVariables((prev) => {
      const [prevStable, prevFinal] = prev;
      const nextFinal = { ...prevFinal, ...variables };

      if (!deepEqual(prevFinal, nextFinal)) {
        return [prevStable, nextFinal];
      } else {
        return prev;
      }
    });
  }, []);

  return [asyncDataToExpose, { isLoading, setVariables }];
};
