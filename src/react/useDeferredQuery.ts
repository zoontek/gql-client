import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { useCallback, useRef, useState } from "react";

import type { ClientError } from "../client/errors";
import type { AnyVariables } from "../types";
import { useClient } from "./context";

/**
 * State of the query returned by `useDeferredQuery`. `status` narrows the
 * shape: `data` is only present on `"success"`, `error` only on `"error"`.
 * Reflects only the most recently started call to the query function.
 */
export type DeferredQueryState<Data> =
  | { fetching: false; status: "idle" }
  | { fetching: true; status: "loading" }
  | { fetching: false; status: "success"; data: Data }
  | { fetching: false; status: "error"; error: ClientError };

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
  const [state, setState] = useState<DeferredQueryState<Data>>({
    status: "idle",
    fetching: false,
  });

  // Identifies the most recent `query` call so that out-of-order responses
  // from overlapping calls don't clobber the state with stale results.
  const latestCallRef = useRef(0);

  const query = useCallback(
    (variables: Variables) => {
      const callId = ++latestCallRef.current;

      setState({ status: "loading", fetching: true });

      return client
        .query(stableDocument, variables)
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
    [client, stableDocument],
  );

  return [state, query];
};
