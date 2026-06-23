import { AsyncData, Future, Result } from "@bloodyowl/boxed";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useContext, useRef, useState } from "react";
import type { GetConnectionUpdate } from "../client";
import { ClientError } from "../errors";
import type { UnknownVariables } from "../types";
import { ClientContext } from "./ClientContext";

export type Mutation<
  Data,
  Variables extends UnknownVariables = UnknownVariables,
> = readonly [
  (variables: Variables) => Future<Result<Data, ClientError>>,
  AsyncData<Result<Data, ClientError>>,
];

export type MutationConfig<
  Data,
  Variables extends UnknownVariables = UnknownVariables,
> = {
  connectionUpdates?: GetConnectionUpdate<Data, Variables>[] | undefined;
};

export const useMutation = <
  Data,
  Variables extends UnknownVariables = UnknownVariables,
>(
  mutation: TypedDocumentNode<Data, Variables>,
  config: MutationConfig<Data, Variables> = {},
): Mutation<Data, Variables> => {
  const client = useContext(ClientContext);

  const connectionUpdatesRef = useRef(config?.connectionUpdates);
  connectionUpdatesRef.current = config?.connectionUpdates;

  const [stableMutation] = useState(mutation);

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
