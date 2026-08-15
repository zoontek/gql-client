import { Suspense, useState } from "react";

import { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { useQuery } from "../../../src/react/useQuery";
import { gql } from "../gql";

type GreetingData = { greeting: string };
type GreetingVariables = { id: string };

const GreetingQuery = gql<GreetingData, GreetingVariables>(
  `query Greeting($id: ID!) { greeting(id: $id) }`,
);

const RefetchInner = ({ client }: { client: Client }): React.ReactNode => {
  const [state] = useQuery(GreetingQuery, { id: "1" });

  return (
    <div>
      <pre data-testid="state">{JSON.stringify(state)}</pre>

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

export const RefetchFixture = ({ url }: { url: string }): React.ReactNode => {
  const [client] = useState(
    () => new Client({ url, schemaConfig: { interfaceToTypes: {} } }),
  );

  return (
    <ClientProvider value={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <RefetchInner client={client} />
      </Suspense>
    </ClientProvider>
  );
};
