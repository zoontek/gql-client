import { useEffect, useRef } from "react";

/**
 * Retains the last defined `value` across renders where it's `undefined`,
 * until `resetKey` changes. Used to keep showing a query's last successful
 * result while a later request for the same variables is in flight.
 */
export const usePreviousData = <T>(
  value: T | undefined,
  resetKey: unknown,
): T | undefined => {
  const previousRef = useRef(value);
  const resetKeyRef = useRef(resetKey);

  // When the reset key changes (new variables passed to the query, as opposed
  // to a `setVariables` call), drop the previous value so the query goes back
  // to its loading state instead of showing the previous result.
  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    previousRef.current = value;
  }

  useEffect(() => {
    if (value !== undefined) {
      previousRef.current = value;
    }
  }, [value]);

  return previousRef.current;
};
