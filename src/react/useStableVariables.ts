import { useCallback, useState } from "react";

import { deepEqual } from "../utils";

type StableVariables<Variables> = {
  provided: Variables;
  effective: Variables;
};

type StableVariablesResult<Variables> = StableVariables<Variables> & {
  propsChanged: boolean;
  setVariables: (variables: Partial<Variables>) => void;
};

// `provided` is the last `variables` prop. `effective` is `provided` with the
// `setVariables` patches. A new prop that is not deeply equal drops the
// patches.
export const useStableVariables = <Variables>(
  variables: Variables,
): StableVariablesResult<Variables> => {
  const [stableVariables, setStableVariables] = useState<
    StableVariables<Variables>
  >({ provided: variables, effective: variables });

  const propsChanged = !deepEqual(stableVariables.provided, variables);

  const current = propsChanged
    ? { provided: variables, effective: variables }
    : stableVariables;

  // Updated during render, so this render already uses the new variables.
  if (propsChanged) {
    setStableVariables(current);
  }

  const setVariables = useCallback((patch: Partial<Variables>) => {
    setStableVariables((prev) => {
      const effective = { ...prev.effective, ...patch };

      return deepEqual(prev.effective, effective)
        ? prev
        : { provided: prev.provided, effective };
    });
  }, []);

  return { ...current, propsChanged, setVariables };
};
