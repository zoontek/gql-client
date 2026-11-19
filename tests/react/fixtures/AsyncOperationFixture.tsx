import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { ReactNode } from "react";

import { useDeferredQuery } from "../../../src/react/useDeferredQuery";
import { useMutation } from "../../../src/react/useMutation";
import type { GreetingVariables } from "../../shared";
import { FixtureRoot } from "./FixtureRoot";

type Document<Data> = TypedDocumentNode<Data, GreetingVariables>;

type Run<Data> = (variables: GreetingVariables) => Promise<Data>;

const Controls = <Data,>({
  state,
  run,
}: {
  state: unknown;
  run: Run<Data>;
}): ReactNode => (
  <div>
    <pre data-testid="state">{JSON.stringify(state)}</pre>

    <button
      data-testid="run-ok"
      onClick={() => run({ id: "1" }).catch(() => {})}
    >
      run ok
    </button>

    <button
      data-testid="run-fail"
      onClick={() => run({ id: "bad" }).catch(() => {})}
    >
      run fail
    </button>
  </div>
);

const MutationInner = <Data,>({ document }: { document: Document<Data> }) => {
  const [state, run] = useMutation(document);
  return <Controls state={state} run={run} />;
};

const DeferredQueryInner = <Data,>({
  document,
}: {
  document: Document<Data>;
}) => {
  const [state, run] = useDeferredQuery(document);
  return <Controls state={state} run={run} />;
};

export const AsyncOperationFixture = <Data,>({
  hook,
  document,
}: {
  hook: "useMutation" | "useDeferredQuery";
  document: Document<Data>;
}): ReactNode => (
  <FixtureRoot>
    {hook === "useMutation" ? (
      <MutationInner document={document} />
    ) : (
      <DeferredQueryInner document={document} />
    )}
  </FixtureRoot>
);
