import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { Suspense } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { useQuery } from "../../../src/react/useQuery";

type Variables = { id: string };

const QueryInner = <Data,>({
  query,
  variables,
}: {
  query: TypedDocumentNode<Data, Variables>;
  variables: Variables;
}) => {
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
    </div>
  );
};

const ErrorFallback = ({ error }: FallbackProps): React.ReactNode => (
  <pre data-testid="error">{(error as Error).message}</pre>
);

export const QueryFixture = <Data,>({
  url,
  query,
  variables,
}: {
  url: string;
  query: TypedDocumentNode<Data, Variables>;
  variables: Variables;
}) => {
  const client = new Client({ url, schema: { interfaceToTypes: {} } });

  return (
    <ClientProvider value={client}>
      <ErrorBoundary fallbackRender={ErrorFallback}>
        <Suspense fallback={<div data-testid="loading">loading</div>}>
          <QueryInner query={query} variables={variables} />
        </Suspense>
      </ErrorBoundary>
    </ClientProvider>
  );
};
