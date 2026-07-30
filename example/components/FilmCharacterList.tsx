import { useForwardPagination } from "../../src";
import { graphql, useFragment, type FragmentType } from "../gql";

const FilmCharactersConnectionFragment = graphql(`
  fragment FilmCharactersConnection on FilmCharactersConnection {
    edges {
      node {
        id
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`);

type Props = {
  characters: FragmentType<typeof FilmCharactersConnectionFragment>;
  onNextPage: (cursor: string | null) => void;
  fetchingMore: boolean;
};

export const FilmCharacterList = ({
  characters,
  onNextPage,
  fetchingMore,
}: Props) => {
  const connection = useForwardPagination(
    useFragment(FilmCharactersConnectionFragment, characters),
  );

  if (connection.edges == null) {
    return null;
  }

  return (
    <>
      <ul>
        {connection.edges.map((edge) => {
          const node = edge?.node;
          return node == null ? null : <li key={node.id}>{node.name}</li>;
        })}
      </ul>

      {fetchingMore ? <div>Fetching more</div> : null}

      {connection.pageInfo.hasNextPage ? (
        <button
          onClick={() => onNextPage(connection.pageInfo.endCursor ?? null)}
          disabled={fetchingMore}
        >
          Load more
        </button>
      ) : null}
    </>
  );
};
