import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useRef, useState } from "react";
import type { GetConnectionUpdate } from "../client/client";
import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
import { useClient } from "./context";

export type MutationState<Data> =
  | { status: "idle"; fetching: false }
  | { status: "loading"; fetching: true }
  | { status: "success"; fetching: false; data: Data }
  | { status: "error"; fetching: false; error: ClientError };

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

  const connectionUpdatesRef = useRef(config.connectionUpdates);
  connectionUpdatesRef.current = config.connectionUpdates;

  const [stableMutation] = useState(mutation);
  const [state, setState] = useState<MutationState<Data>>({
    status: "idle",
    fetching: false,
  });

  // Identifies the most recent `mutate` call so that out-of-order responses
  // from overlapping mutations don't clobber the state with stale results.
  const latestCallRef = useRef(0);

  const mutate = useCallback(
    (variables: Variables) => {
      const callId = ++latestCallRef.current;

      setState({ status: "loading", fetching: true });

      return client
        .request(stableMutation, variables, {
          connectionUpdates: connectionUpdatesRef.current,
        })
        .then((data) => {
          if (latestCallRef.current === callId) {
            setState({ status: "success", fetching: false, data });
          }

          return data;
        })
        .catch((error: ClientError) => {
          if (latestCallRef.current === callId) {
            setState({ status: "error", fetching: false, error });
          }

          throw error;
        });
    },
    [client, stableMutation],
  );

  return [mutate, state];
};
