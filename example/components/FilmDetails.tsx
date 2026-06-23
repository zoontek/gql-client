import { useQuery } from "../../src";
import { graphql } from "../gql";
import { FilmCharacterList } from "./FilmCharacterList";

const FilmDetailsQuery = graphql(`
  query FilmDetails($filmId: ID!, $first: Int!, $after: String) {
    film(id: $filmId) {
      id
      title
      director
      producers
      openingCrawl
      characterConnection(first: $first, after: $after) {
        ...FilmCharactersConnection
      }
      releaseDate
    }
  }
`);

type Props = {
  filmId: string;
};

export const FilmDetails = ({ filmId }: Props) => {
  const [{ data, fetching }, { setVariables }] = useQuery(FilmDetailsQuery, {
    filmId,
    first: 5,
  });

  const { film } = data;

  return (
    <div className="FilmDetails" style={{ opacity: fetching ? 0.5 : 1 }}>
      {film == null ? (
        <div>No film</div>
      ) : (
        <>
          <h1>{film.title}</h1>
          <div>Director: {film.director}</div>
          <div>Release date: {film.releaseDate}</div>
          <div>
            Producers: <span>{film.producers?.join(", ")}</span>
          </div>
          <div>
            Opening crawl:
            <pre>{film.openingCrawl}</pre>
          </div>
          {film.characterConnection != null ? (
            <>
              <h2>Characters</h2>
              <FilmCharacterList
                characters={film.characterConnection}
                onNextPage={(after) => setVariables({ after })}
                fetchingMore={fetching}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
};
