import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { useMutation } from "../../../src/react/useMutation";

type Variables = { id: string };

const MutationInner = <Data,>({
  mutation,
}: {
  mutation: TypedDocumentNode<Data, Variables>;
}) => {
  const [state, mutate] = useMutation(mutation);

  return (
    <div>
      <pre data-testid="state">{JSON.stringify(state)}</pre>
      <button
        data-testid="mutate-ok"
        onClick={() => mutate({ id: "1" }).catch(() => {})}
      >
        mutate ok
      </button>
      <button
        data-testid="mutate-fail"
        onClick={() => mutate({ id: "bad" }).catch(() => {})}
      >
        mutate fail
      </button>
    </div>
  );
};

export const MutationFixture = <Data,>({
  url,
  mutation,
}: {
  url: string;
  mutation: TypedDocumentNode<Data, Variables>;
}) => {
  const client = new Client({ url, schema: { interfaceToTypes: {} } });

  return (
    <ClientProvider value={client}>
      <MutationInner mutation={mutation} />
    </ClientProvider>
  );
};
