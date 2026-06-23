import { AsyncData, Future, Result } from "@bloodyowl/boxed";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useRef, useState } from "react";
import type { GetConnectionUpdate } from "../client";
import type { ClientError } from "../errors";
import type { AnyVariables } from "../types";
import { useClient } from "./context";

export type Mutation<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = readonly [
  (variables: Variables) => Future<Result<Data, ClientError>>,
  AsyncData<Result<Data, ClientError>>,
];

export type MutationConfig<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = {
  connectionUpdates?: GetConnectionUpdate<Data, Variables>[] | undefined;
};

export const useMutation = <
  Data,
  Variables extends AnyVariables = AnyVariables,
>(
  mutation: TypedDocumentNode<Data, Variables>,
  config: MutationConfig<Data, Variables> = {},
): Mutation<Data, Variables> => {
  const client = useClient();

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
