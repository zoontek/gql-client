import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useRef, useState } from "react";

import type { MutationConfig } from "../client/client";
import type { AnyVariables } from "../types";
import { useClient } from "./context";
import {
  useAsyncOperation,
  type AsyncOperationState,
} from "./useAsyncOperation";

/**
 * State of the mutation returned by `useMutation`. `status` narrows the
 * shape: `data` is only present on `"success"`, `error` only on `"error"`.
 * Reflects only the most recently started call to the mutate function.
 */
export type MutationState<Data> = AsyncOperationState<Data>;

/** Return type of `useMutation`: a `[state, mutate]` tuple. */
export type Mutation<Data, Variables extends AnyVariables> = readonly [
  MutationState<Data>,
  (variables: Variables) => Promise<Data>,
];

/**
 * Returns a `mutate` function for `mutation` and its current `MutationState`.
 * Calling `mutate` sends the request and updates state as it resolves. If
 * `mutate` is called again before the first call resolves, only the most
 * recently started call's result is reflected in `state`.
 *
 * @param mutation - The mutation document to run.
 * @param config - Optional. See `MutationConfig` for the available options.
 * @returns A `[state, mutate]` tuple; see `Mutation`.
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
