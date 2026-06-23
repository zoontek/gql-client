import { AsyncData, Future, Result } from "@bloodyowl/boxed";
import { useCallback, useContext, useRef, useState } from "react";
import type { GetConnectionUpdate } from "../client";
import { ClientError } from "../errors";
import type { TypedDocumentNode } from "../types";
import { ClientContext } from "./ClientContext";

export type Mutation<Data, Variables> = readonly [
  (variables: Variables) => Future<Result<Data, ClientError>>,
  AsyncData<Result<Data, ClientError>>,
];

export type MutationConfig<Data, Variables> = {
  connectionUpdates?: GetConnectionUpdate<Data, Variables>[] | undefined;
};

export const useMutation = <Data, Variables>(
  mutation: TypedDocumentNode<Data, Variables>,
  config: MutationConfig<Data, Variables> = {},
): Mutation<Data, Variables> => {
  const client = useContext(ClientContext);

  const connectionUpdatesRef = useRef(config?.connectionUpdates);
  connectionUpdatesRef.current = config?.connectionUpdates;

  const [stableMutation] =
    useState<TypedDocumentNode<Data, Variables>>(mutation);

  const [data, setData] = useState<AsyncData<Result<Data, ClientError>>>(
    AsyncData.NotAsked(),
  );

  const mutate = useCallback(
    (variables: Variables) => {
      setData(AsyncData.Loading());
      return client
        .request(stableMutation, variables, {
          connectionUpdates: connectionUpdatesRef.current,
        })
        .tap((result) => setData(AsyncData.Done(result)));
    },
    [client, stableMutation],
  );

  return [mutate, data];
};
