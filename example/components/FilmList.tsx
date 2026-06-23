import { Option } from "@bloodyowl/boxed";
import { useForwardPagination } from "../../src";
import { graphql, useFragment, type FragmentType } from "../gql";
import { Film } from "./Film";

const FilmsConnectionFragment = graphql(`
  fragment FilmsConnection on FilmsConnection {
    edges {
      node {
        id
        ...FilmItem
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`);

type Props = {
  films: FragmentType<typeof FilmsConnectionFragment>;
  onNextPage: (cursor: string | null) => void;
  fetchingMore: boolean;
  activeFilm: Option<string>;
  onPressFilm: (filmId: string) => void;
};

export const FilmList = ({
  films,
  onNextPage,
  activeFilm,
  onPressFilm,
  fetchingMore,
}: Props) => {
  const connection = useForwardPagination(
    useFragment(FilmsConnectionFragment, films),
  );

  if (connection.edges == null) {
    return null;
  }

  return (
    <>
      {connection.edges.map((edge) => {
        if (edge == null) {
          return null;
        }
        const node = edge.node;
        if (node == null) {
          return null;
        }
        return (
          <Film
            film={node}
            key={node.id}
            isActive={activeFilm.map((id) => node.id === id).getOr(false)}
            onPress={onPressFilm}
          />
        );
      })}

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
