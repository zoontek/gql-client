import { Suspense, useState } from "react";

import { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { useForwardPagination } from "../../../src/react/usePagination";
import { useQuery } from "../../../src/react/useQuery";
import type { Connection } from "../../../src/types";
import { gql } from "../gql";

type FilmNode = { __typename: "Film"; id: string; title: string };

type FilmsData = {
  films: Connection<FilmNode> & { __typename: "FilmsConnection" };
};

type FilmsVariables = { era: string; after?: string };

const FilmsQuery = gql<FilmsData, FilmsVariables>(`
  query Films($era: String!, $after: String) {
    films(era: $era, after: $after) {
      __typename
      edges {
        __typename
        cursor
        node {
          __typename
          id
          title
        }
      }
      pageInfo {
        hasPreviousPage
        hasNextPage
        startCursor
        endCursor
      }
    }
  }
`);

const PaginationSwitchInner = (): React.ReactNode => {
  const [era, setEra] = useState("a");
  const [state] = useQuery(FilmsQuery, { era });
  const connection = useForwardPagination(state.data.films);
  const titles = (connection?.edges ?? []).map((edge) => edge?.node?.title);

  return (
    <div>
      <pre data-testid="titles">{JSON.stringify(titles)}</pre>

      <button data-testid="era-a" onClick={() => setEra("a")}>
        era a
      </button>

      <button data-testid="era-b" onClick={() => setEra("b")}>
        era b
      </button>
    </div>
  );
};

export const PaginationSwitchFixture = ({
  url,
}: {
  url: string;
}): React.ReactNode => {
  const client = new Client({ url, schemaConfig: { interfaceToTypes: {} } });

  return (
    <ClientProvider value={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <PaginationSwitchInner />
      </Suspense>
    </ClientProvider>
  );
};
