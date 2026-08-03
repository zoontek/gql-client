import { useCallback, useState } from "react";

import { deepEqual } from "../utils";

type StableVariables<Variables> = {
  // The variables last passed by the caller. Used to detect a prop change and
  // as the reset key for `usePreviousData`.
  provided: Variables;
  // The variables actually fetched and read with. `setVariables` patches this
  // alone, so a local override survives until the caller passes new variables.
  effective: Variables;
};

/** Return type of `useStableVariables`. */
export type StableVariablesResult<Variables> = {
  provided: Variables;
  effective: Variables;
  /**
   * `true` when the caller passed new (deeply unequal) variables this render,
   * as opposed to a `setVariables` patch. Callers use this to reset their own
   * per-request state (e.g. a captured error) in the same render.
   */
  propsChanged: boolean;
  /** Patches the effective variables without waiting for new props. */
  setVariables: (variables: Partial<Variables>) => void;
};

/**
 * Tracks a query's variables across renders, distinguishing a caller-passed
 * prop change from a `setVariables` patch.
 *
 * When `variables` changes (deeply unequal to the last provided value), both
 * `provided` and `effective` reset to it, dropping any `setVariables` patch.
 * State is adjusted during render (rather than in an effect) so the new
 * variables take effect on this render; an effect would let one render commit
 * and fetch with the stale variables first. React discards and re-renders on
 * the in-render `setState`, so nothing commits with the old variables.
 *
 * @param variables - The variables passed by the caller this render.
 */
export const useStableVariables = <Variables>(
  variables: Variables,
): StableVariablesResult<Variables> => {
  const [stableVariables, setStableVariables] = useState<
    StableVariables<Variables>
  >({ provided: variables, effective: variables });

  const propsChanged = !deepEqual(stableVariables.provided, variables);

  if (propsChanged) {
    setStableVariables({ provided: variables, effective: variables });
  }

  const { provided, effective } = propsChanged
    ? { provided: variables, effective: variables }
    : stableVariables;

  const setVariables = useCallback((patch: Partial<Variables>) => {
    setStableVariables((prev) => {
      const effective = { ...prev.effective, ...patch };

      return deepEqual(prev.effective, effective)
        ? prev
        : { provided: prev.provided, effective };
    });
  }, []);

  return { provided, effective, propsChanged, setVariables };
};
