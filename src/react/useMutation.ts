import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useRef, useState } from "react";
import type { GetConnectionUpdate } from "../client";
import type { ClientError } from "../errors";
import type { AnyVariables } from "../types";
import { useClient } from "./context";

export type MutationState<Data> =
  | { fetching: false }
  | { fetching: true }
  | { fetching: false; data: Data }
  | { fetching: false; error: ClientError };

export type Mutation<
  Data,
  Variables extends AnyVariables = AnyVariables,
> = readonly [(variables: Variables) => Promise<Data>, MutationState<Data>];

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
  const [state, setState] = useState<MutationState<Data>>({ fetching: false });

  const mutate = useCallback(
    (variables: Variables) => {
      setState({ fetching: true });

      return client
        .request(stableMutation, variables, {
          connectionUpdates: connectionUpdatesRef.current,
        })
        .then((data) => {
          setState({ fetching: false, data });
          return data;
        })
        .catch((error) => {
          setState({ fetching: false, error });
          throw error;
        });
    },
    [client, stableMutation],
  );

  return [mutate, state];
};
