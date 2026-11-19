import { useState, type ReactNode } from "react";

import type { Client } from "../../../src/client/client";
import { transformDocument } from "../../../src/graphql/transform";
import { useForwardPagination } from "../../../src/react/usePagination";
import { useQuery } from "../../../src/react/useQuery";
import type { Connection } from "../../../src/types";
import { createClient, gql } from "../../shared";
import { FixtureRoot } from "./FixtureRoot";

type FilmNode = { __typename: "Film"; id: string; title: string };

type FilmsData = {
  films: Connection<FilmNode> & { __typename: "FilmsConnection" };
};

const connectionFields = `
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
`;

const FilmsQuery = gql<FilmsData, { after?: string }>(`
  query Films($after: String) {
    films(after: $after) { ${connectionFields} }
  }
`);

const FilmsByEraQuery = gql<FilmsData, { era: string; after?: string }>(`
  query Films($era: String!, $after: String) {
    films(era: $era, after: $after) { ${connectionFields} }
  }
`);

const Titles = ({
  connection,
}: {
  connection: FilmsData["films"];
}): ReactNode => (
  <pre data-testid="titles">
    {JSON.stringify((connection?.edges ?? []).map((edge) => edge?.node?.title))}
  </pre>
);

const NextPage = (): ReactNode => {
  const [state, actions] = useQuery(FilmsQuery, {});
  const connection = useForwardPagination(state.data.films);

  return (
    <div>
      <Titles connection={connection} />

      <pre data-testid="has-next-page">
        {JSON.stringify(connection?.pageInfo.hasNextPage ?? null)}
      </pre>

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

const EraSwitch = (): ReactNode => {
  const [era, setEra] = useState("a");
  const [state] = useQuery(FilmsByEraQuery, { era });
  const connection = useForwardPagination(state.data.films);

  return (
    <div>
      <Titles connection={connection} />

      <button data-testid="era-a" onClick={() => setEra("a")}>
        era a
      </button>

      <button data-testid="era-b" onClick={() => setEra("b")}>
        era b
      </button>
    </div>
  );
};

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
const createRestoredClient = (): Client => {
  const server = createClient({ url: "/graphql" });
  server.cache.writeOperation(transformDocument(FilmsQuery), firstPage, {});

  const browser = createClient({ url: "/graphql" });
  browser.restore(server.extract());
  return browser;
};

export const PaginationFixture = (): ReactNode => (
  <FixtureRoot>
    <NextPage />
  </FixtureRoot>
);

export const PaginationSwitchFixture = (): ReactNode => (
  <FixtureRoot>
    <EraSwitch />
  </FixtureRoot>
);

export const PaginationRestoreFixture = (): ReactNode => (
  <FixtureRoot client={createRestoredClient}>
    <NextPage />
  </FixtureRoot>
);
