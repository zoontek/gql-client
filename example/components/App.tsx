import { Option } from "@bloodyowl/boxed";
import { Suspense, useState } from "react";
import { useQuery } from "../../src";
import { graphql } from "../gql";
import { FilmDetails } from "./FilmDetails";
import { FilmList } from "./FilmList";

const AllFilmsQuery = graphql(`
  query allFilmsWithVariablesQuery($first: Int!, $after: String) {
    allFilms(first: $first, after: $after) {
      ...FilmsConnection
    }
  }
`);

export const App = () => {
  const [activeFilm, setActiveFilm] = useState<Option<string>>(Option.None());

  const [data, { fetching, setVariables }] = useQuery(AllFilmsQuery, {
    first: 3,
  });

  return (
    <div className="App">
      {data.match({
        NotAsked: () => null,
        Loading: () => <div>Fetching…</div>,
        Done: (result) =>
          result.match({
            Error: () => <div>An error occured</div>,
            Ok: ({ allFilms }) => {
              if (allFilms == null) {
                return <div>No films</div>;
              }
              return (
                <div className="Main">
                  <div className="Sidebar">
                    <FilmList
                      films={allFilms}
                      onNextPage={(after) => setVariables({ after })}
                      fetchingMore={fetching}
                      activeFilm={activeFilm}
                      onPressFilm={(filmId: string) =>
                        setActiveFilm(Option.Some(filmId))
                      }
                    />
                  </div>
                  <div className="Contents">
                    {activeFilm.match({
                      None: () => <div>No film selected</div>,
                      Some: (filmId) => (
                        <Suspense fallback={<h1>Fetching…</h1>}>
                          <FilmDetails filmId={filmId} />
                        </Suspense>
                      ),
                    })}
                  </div>
                </div>
              );
            },
          }),
      })}
    </div>
  );
};
