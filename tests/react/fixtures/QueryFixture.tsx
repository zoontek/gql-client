import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { ReactNode } from "react";

import { useClient } from "../../../src/react/context";
import { useQuery } from "../../../src/react/useQuery";
import type { GreetingVariables } from "../../shared";
import { FixtureRoot } from "./FixtureRoot";

type Props<Data> = {
  query: TypedDocumentNode<Data, GreetingVariables>;
  variables: GreetingVariables;
};

const QueryInner = <Data,>({ query, variables }: Props<Data>): ReactNode => {
  const client = useClient();
  const [state, actions] = useQuery(query, variables);

  return (
    <div>
      <pre data-testid="state">{JSON.stringify(state)}</pre>

      <button
        data-testid="set-id-2"
        onClick={() => actions.setVariables({ id: "2" })}
      >
        set id=2
      </button>

      <button
        data-testid="set-id-bad"
        onClick={() => actions.setVariables({ id: "bad" })}
      >
        set id=bad
      </button>

      <button data-testid="refetch" onClick={() => actions.refetch()}>
        refetch
      </button>

      <button
        data-testid="refetch-all"
        onClick={() => {
          void client.refetch();
        }}
      >
        refetch all
      </button>
    </div>
  );
};

export const QueryFixture = <Data,>(props: Props<Data>): ReactNode => (
  <FixtureRoot errorBoundary>
    <QueryInner {...props} />
  </FixtureRoot>
);
