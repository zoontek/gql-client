import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { AsyncData, Future, Option, Result } from "@swan-io/boxed";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { RequestOverrides } from "../client";
import { ClientError } from "../errors";
import { deepEqual } from "../utils";
import { ClientContext } from "./ClientContext";

type DeferredQueryExtraConfig = { overrides?: RequestOverrides };

type DeferredQuery<Data, Variables> = readonly [
  AsyncData<Result<Data, ClientError>>,
  {
    query: (
      variables: Variables,
      config?: DeferredQueryExtraConfig,
    ) => Future<Result<Data, ClientError>>;
    reset: () => void;
  },
];

export const useDeferredQuery = <Data, Variables>(
  query: TypedDocumentNode<Data, Variables>,
): DeferredQuery<Data, Variables> => {
  const client = useContext(ClientContext);

  // Query should never change
  const [stableQuery] = useState<TypedDocumentNode<Data, Variables>>(query);

  // Only break variables reference equality if not deeply equal
  const [stableVariables, setStableVariables] = useState<Option<Variables>>(
    Option.None(),
  );

  // Get data from cache
  const getSnapshot = useCallback(() => {
    return stableVariables.flatMap((variables) =>
      client.readFromCache(stableQuery, variables),
    );
  }, [client, stableQuery, stableVariables]);

  const data = useSyncExternalStore(
    (func) => client.subscribe(func),
    getSnapshot,
  );

  const asyncData = useMemo(() => {
    return data
      .map((value) => AsyncData.Done(value as Result<Data, ClientError>))
      .getOr(AsyncData.NotAsked());
  }, [data]);

  const runQuery = useCallback(
    (variables: Variables, { overrides }: DeferredQueryExtraConfig = {}) => {
      setIsQuerying(true);
      setStableVariables((stableVariables) =>
        stableVariables.match({
          None: () => Option.Some(variables),
          Some: (prevVariables) =>
            deepEqual(prevVariables, variables)
              ? stableVariables
              : Option.Some(variables),
        }),
      );
      return client
        .request(stableQuery, variables, { overrides })
        .tap(() => setIsQuerying(false));
    },
    [client, stableQuery],
  );

  const [isQuerying, setIsQuerying] = useState(false);

  const reset = useCallback(() => {
    setIsQuerying(false);
    setStableVariables(Option.None());
  }, []);

  const asyncDataToExpose = isQuerying ? AsyncData.Loading() : asyncData;

  return [asyncDataToExpose, { query: runQuery, reset }];
};
