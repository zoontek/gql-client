import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useRef, useState } from "react";

import type { MutationConfig } from "../client/client";
import type { AnyVariables } from "../types";
import { useClient } from "./context";
import {
  useAsyncOperation,
  type AsyncOperationState,
} from "./useAsyncOperation";

/** State returned by `useMutation`. Narrow it on `status`. */
export type MutationState<Data> = AsyncOperationState<Data>;

/** `[state, mutate]` tuple returned by `useMutation`. */
export type Mutation<Data, Variables extends AnyVariables> = readonly [
  MutationState<Data>,
  (variables: Variables) => Promise<Data>,
];

/**
 * Returns a `mutate` function and its state. Nothing is sent until you call
 * `mutate`. The response is written into the cache. If you call `mutate`
 * again before the previous call settles, `state` shows only the latest call.
 *
 * @see https://zoontek.github.io/gql-client/mutations
 */
export const useMutation = <Data, Variables extends AnyVariables>(
  mutation: TypedDocumentNode<Data, Variables>,
  config: MutationConfig<Data, Variables> = {},
): Mutation<Data, Variables> => {
  const client = useClient();

  const connectionUpdatesRef = useRef(config.connectionUpdates);
  connectionUpdatesRef.current = config.connectionUpdates;

  const [stableMutation] = useState(mutation);

  const run = useCallback(
    (variables: Variables) =>
      client.mutate(stableMutation, variables, {
        connectionUpdates: connectionUpdatesRef.current,
      }),
    [client, stableMutation],
  );

  return useAsyncOperation(run);
};
