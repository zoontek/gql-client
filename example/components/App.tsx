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
  const [activeFilm, setActiveFilm] = useState<string | undefined>(undefined);

  const [{ data, fetching }, { setVariables }] = useQuery(AllFilmsQuery, {
    first: 3,
  });

  const { allFilms } = data;

  return (
    <div className="App">
      <div className="Main">
        <div className="Sidebar">
          {allFilms == null ? (
            <div>No films</div>
          ) : (
            <FilmList
              films={allFilms}
              onNextPage={(after) => setVariables({ after })}
              fetchingMore={fetching}
              activeFilm={activeFilm}
              onPressFilm={(filmId: string) => setActiveFilm(filmId)}
            />
          )}
        </div>

        <div className="Contents">
          {activeFilm === undefined ? (
            <div>No film selected</div>
          ) : (
            <Suspense fallback={<h1>Fetching…</h1>}>
              <FilmDetails filmId={activeFilm} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
};
