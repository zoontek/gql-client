import { Suspense, useState } from "react";

import { Client } from "../../../src/client/client";
import { transformDocument } from "../../../src/graphql/transform";
import { ClientProvider } from "../../../src/react/context";
import { useForwardPagination } from "../../../src/react/usePagination";
import { useQuery } from "../../../src/react/useQuery";
import type { Connection } from "../../../src/types";
import { gql } from "../gql";

type FilmNode = { __typename: "Film"; id: string; title: string };

type FilmsData = {
  films: Connection<FilmNode> & { __typename: "FilmsConnection" };
};

type FilmsVariables = { after?: string };

const FilmsQuery = gql<FilmsData, FilmsVariables>(`
  query Films($after: String) {
    films(after: $after) {
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

const firstPage = {
  __typename: "Query",
  films: {
    __typename: "FilmsConnection",
    edges: [
      {
        __typename: "FilmsEdge",
        cursor: "c1",
        node: { __typename: "Film", id: "f1", title: "First" },
      },
    ],
    pageInfo: {
      hasPreviousPage: false,
      hasNextPage: true,
      startCursor: "c1",
      endCursor: "c1",
    },
  },
};

// Builds a client the way a browser would after SSR: the first page comes
// from a serialized cache, not from a request made by this client.
const createRestoredClient = (url: string): Client => {
  const server = new Client({ url, schemaConfig: { interfaceToTypes: {} } });
  server.cache.writeOperation(transformDocument(FilmsQuery), firstPage, {});

  const browser = new Client({ url, schemaConfig: { interfaceToTypes: {} } });
  browser.restore(server.extract());
  return browser;
};

const PaginationRestoreInner = (): React.ReactNode => {
  const [state, actions] = useQuery(FilmsQuery, {});
  const connection = useForwardPagination(state.data.films);
  const titles = (connection?.edges ?? []).map((edge) => edge?.node?.title);

  return (
    <div>
      <pre data-testid="titles">{JSON.stringify(titles)}</pre>

      <button
        data-testid="load-next"
        onClick={() => {
          const endCursor = connection?.pageInfo.endCursor;
          actions.setVariables(endCursor ? { after: endCursor } : {});
        }}
      >
        load next
      </button>
    </div>
  );
};

export const PaginationRestoreFixture = ({
  url,
}: {
  url: string;
}): React.ReactNode => {
  const [client] = useState(() => createRestoredClient(url));

  return (
    <ClientProvider value={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <PaginationRestoreInner />
      </Suspense>
    </ClientProvider>
  );
};
