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

  const [state, { setVariables }] = useQuery(AllFilmsQuery, {
    first: 3,
  });

  const renderContents = () => {
    if ("error" in state) {
      return <div>An error occured</div>;
    }
    if (!("data" in state)) {
      return <div>Fetching…</div>;
    }

    const { allFilms } = state.data;
    if (allFilms == null) {
      return <div>No films</div>;
    }

    return (
      <div className="Main">
        <div className="Sidebar">
          <FilmList
            films={allFilms}
            onNextPage={(after) => setVariables({ after })}
            fetchingMore={state.fetching}
            activeFilm={activeFilm}
            onPressFilm={(filmId: string) => setActiveFilm(filmId)}
          />
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
    );
  };

  return <div className="App">{renderContents()}</div>;
};
