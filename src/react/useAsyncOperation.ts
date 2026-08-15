import { useCallback, useRef, useState } from "react";

import type { ClientError } from "../client/errors";

/**
 * State shared by `useMutation` and `useDeferredQuery`. `status` narrows the
 * shape: `data` is only present on `"success"`, `error` only on `"error"`.
 * Reflects only the most recently started call.
 */
export type AsyncOperationState<Data> =
  | { fetching: false; status: "idle" }
  | { fetching: true; status: "loading" }
  | { fetching: false; status: "success"; data: Data }
  | { fetching: false; status: "error"; error: ClientError };

// Internal state machine behind `useMutation` and `useDeferredQuery`: run the
// request, reflect only the most recently started call in state, and return
// the request promise to the caller.
export const useAsyncOperation = <Data, Variables>(
  run: (variables: Variables) => Promise<Data>,
): readonly [
  AsyncOperationState<Data>,
  (variables: Variables) => Promise<Data>,
] => {
  const [state, setState] = useState<AsyncOperationState<Data>>({
    status: "idle",
    fetching: false,
  });

  // Identifies the most recent call so that out-of-order responses from
  // overlapping calls can't overwrite the state with stale results.
  const latestCallRef = useRef(0);

  const start = useCallback(
    (variables: Variables) => {
      const callId = ++latestCallRef.current;

      setState({ status: "loading", fetching: true });

      const promise = run(variables).then(
        (data) => {
          if (latestCallRef.current === callId) {
            setState({ status: "success", fetching: false, data });
          }

          return data;
        },
        (error: ClientError) => {
          if (latestCallRef.current === callId) {
            setState({ status: "error", fetching: false, error });
          }

          throw error;
        },
      );

      // The error already lands in `state`; callers driving their UI from it
      // alone would otherwise get an unhandled rejection for every failure.
      // Attaching a no-op handler marks the promise as handled while awaiting
      // callers still observe the rejection.
      promise.catch(() => {});

      return promise;
    },
    [run],
  );

  return [state, start];
};
