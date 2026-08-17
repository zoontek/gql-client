import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { useDeferredQuery } from "../../../src/react/useDeferredQuery";

type Variables = { id: string };

const DeferredQueryInner = <Data,>({
  query,
}: {
  query: TypedDocumentNode<Data, Variables>;
}) => {
  const [state, executeQuery] = useDeferredQuery(query);

  return (
    <div>
      <pre data-testid="state">{JSON.stringify(state)}</pre>
      <button
        data-testid="query-ok"
        onClick={() => executeQuery({ id: "1" }).catch(() => {})}
      >
        query ok
      </button>

      <button
        data-testid="query-fail"
        onClick={() => executeQuery({ id: "bad" }).catch(() => {})}
      >
        query fail
      </button>
    </div>
  );
};

export const DeferredQueryFixture = <Data,>({
  url,
  query,
}: {
  url: string;
  query: TypedDocumentNode<Data, Variables>;
}) => {
  const client = new Client({ url, schemaConfig: { interfaceToTypes: {} } });

  return (
    <ClientProvider value={client}>
      <DeferredQueryInner query={query} />
    </ClientProvider>
  );
};
