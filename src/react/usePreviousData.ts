import { useEffect, useRef } from "react";

export const usePreviousData = <T>(
  value: T | undefined,
  resetKey: unknown,
): T | undefined => {
  const previousRef = useRef(value);
  const resetKeyRef = useRef(resetKey);

  // A new `resetKey` (a new `variables` prop, not a `setVariables` call) drops
  // the previous value, so the query shows its loading state.
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
