import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useState } from "react";

import type { AnyVariables } from "../types";
import { useClient } from "./context";
import {
  useAsyncOperation,
  type AsyncOperationState,
} from "./useAsyncOperation";

/**
 * State of the query returned by `useDeferredQuery`. `status` narrows the
 * shape: `data` is only present on `"success"`, `error` only on `"error"`.
 * Reflects only the most recently started call to the query function.
 */
export type DeferredQueryState<Data> = AsyncOperationState<Data>;

/** Return type of `useDeferredQuery`: a `[state, query]` tuple. */
export type DeferredQuery<Data, Variables extends AnyVariables> = readonly [
  DeferredQueryState<Data>,
  (variables: NoInfer<Variables>) => Promise<Data>,
];

/**
 * Returns a `query` function for `document` and its current
 * `DeferredQueryState`. Unlike `useQuery`, the request isn't sent
 * automatically: call `query` to send it. Calling `query` again before the
 * first call resolves reflects only the most recently started call's result
 * in `state`.
 *
 * @param document - The query document to run.
 * @returns A `[state, query]` tuple; see `DeferredQuery`.
 */
export const useDeferredQuery = <Data, Variables extends AnyVariables>(
  document: TypedDocumentNode<Data, Variables>,
): DeferredQuery<Data, Variables> => {
  const client = useClient();

  const [stableDocument] = useState(document);

  const run = useCallback(
    (variables: Variables) =>
      // An explicit call means "fetch now": replace a stored settled
      // response, but still join a request already in flight.
      client.query(stableDocument, variables, { refresh: true }),
    [client, stableDocument],
  );

  return useAsyncOperation(run);
};
