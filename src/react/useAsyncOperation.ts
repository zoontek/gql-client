import { useCallback, useRef, useState } from "react";

import type { ClientError } from "../client/errors";

export type AsyncOperationState<Data> =
  | { fetching: false; status: "idle" }
  | { fetching: true; status: "loading" }
  | { fetching: false; status: "success"; data: Data }
  | { fetching: false; status: "error"; error: ClientError };

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

  // Only the latest call updates `state`, so a late response of an older call
  // is ignored.
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

      // The error is already in `state`. This handler prevents an unhandled
      // rejection for callers that do not await. Callers that await still get
      // the rejection.
      promise.catch(() => {});

      return promise;
    },
    [run],
  );

  return [state, start];
};
