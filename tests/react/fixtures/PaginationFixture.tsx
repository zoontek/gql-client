import { Suspense } from "react";
import { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { useForwardPagination } from "../../../src/react/usePagination";
import { useQuery } from "../../../src/react/useQuery";
import type { Connection } from "../../../src/types";
import { typedDoc } from "../typedDoc";

type FilmNode = { __typename: "Film"; id: string; title: string };

type FilmsData = {
  films: Connection<FilmNode> & { __typename: "FilmsConnection" };
};

type FilmsVariables = { after?: string };

export const FilmsQuery = typedDoc<FilmsData, FilmsVariables>(`
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

const PaginationInner = (): React.ReactNode => {
  const [state, actions] = useQuery(FilmsQuery, {});
  const connection = useForwardPagination(state.data.films);
  const titles = (connection?.edges ?? []).map((edge) => edge?.node?.title);

  return (
    <div>
      <pre data-testid="titles">{JSON.stringify(titles)}</pre>
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

export const PaginationFixture = ({
  url,
}: {
  url: string;
}): React.ReactNode => {
  const client = new Client({ url, schemaConfig: { interfaceToTypes: {} } });

  return (
    <ClientProvider value={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <PaginationInner />
      </Suspense>
    </ClientProvider>
  );
};
