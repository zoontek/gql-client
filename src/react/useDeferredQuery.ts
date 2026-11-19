import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useState } from "react";

import type { AnyVariables } from "../types";
import { useClient } from "./context";
import {
  useAsyncOperation,
  type AsyncOperationState,
} from "./useAsyncOperation";

/** State returned by `useDeferredQuery`. Narrow it on `status`. */
export type DeferredQueryState<Data> = AsyncOperationState<Data>;

/** `[state, run]` tuple returned by `useDeferredQuery`. */
export type DeferredQuery<Data, Variables extends AnyVariables> = readonly [
  DeferredQueryState<Data>,
  (variables: NoInfer<Variables>) => Promise<Data>,
];

/**
 * Like `useQuery`, but sends nothing on render. Call the returned function to
 * run the query. Each call sends a new request, unless a request for the same
 * variables is in flight. If you call it again before the previous call
 * settles, `state` shows only the latest call.
 *
 * @see https://zoontek.github.io/gql-client/queries#usedeferredquery
 */
export const useDeferredQuery = <Data, Variables extends AnyVariables>(
  document: TypedDocumentNode<Data, Variables>,
): DeferredQuery<Data, Variables> => {
  const client = useClient();

  const [stableDocument] = useState(document);

  const run = useCallback(
    (variables: Variables) =>
      client.query(stableDocument, variables, { refresh: true }),
    [client, stableDocument],
  );

  return useAsyncOperation(run);
};
