import { expect, test } from "@playwright/experimental-ct-react";

import {
  PaginationFixture,
  PaginationRestoreFixture,
  PaginationSwitchFixture,
} from "./fixtures/PaginationFixture";
import { routeGraphQL } from "./helpers";

const filmEdge = (cursor: string, id: string, title: string) => ({
  __typename: "FilmsEdge",
  cursor,
  node: { __typename: "Film", id, title },
});

type FilmEdge = ReturnType<typeof filmEdge>;

const filmsPage = (
  edges: FilmEdge[],
  pageInfo: { hasPreviousPage: boolean; hasNextPage: boolean },
) => ({
  json: {
    data: {
      __typename: "Query",
      films: {
        __typename: "FilmsConnection",
        edges,
        pageInfo: {
          ...pageInfo,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
        },
      },
    },
  },
});

test("useForwardPagination merges a next page into the connection's edges", async ({
  mount,
  page,
}) => {
  await routeGraphQL<{ after?: string }>(page, ({ after }) =>
    after == null
      ? filmsPage(
          [
            filmEdge("c1", "f1", "A New Hope"),
            filmEdge("c2", "f2", "Empire Strikes Back"),
          ],
          { hasPreviousPage: false, hasNextPage: true },
        )
      : filmsPage([filmEdge("c3", "f3", "Return of the Jedi")], {
          hasPreviousPage: true,
          hasNextPage: false,
        }),
  );

  const component = await mount(<PaginationFixture />);

  await expect(component.getByTestId("titles")).toContainText(
    "Empire Strikes Back",
  );
  await expect(component.getByTestId("has-next-page")).toContainText("true");

  await component.getByTestId("load-next").click();

  await expect(component.getByTestId("titles")).toContainText(
    JSON.stringify(["A New Hope", "Empire Strikes Back", "Return of the Jedi"]),
  );
  await expect(component.getByTestId("has-next-page")).toContainText("false");
});

test("switching to an already-cached connection shows that connection's pages", async ({
  mount,
  page,
}) => {
  await routeGraphQL<{ era: string }>(page, ({ era }) =>
    filmsPage([filmEdge(`${era}-c1`, `${era}-f1`, `${era}-film`)], {
      hasPreviousPage: false,
      hasNextPage: true,
    }),
  );

  const component = await mount(<PaginationSwitchFixture />);

  await expect(component.getByTestId("titles")).toContainText("a-film");

  await component.getByTestId("era-b").click();
  await expect(component.getByTestId("titles")).toContainText("b-film");

  // Era "a" is served from the cache: no network request, no cache write. The
  // pagination hook must still switch back to era a's pages.
  await component.getByTestId("era-a").click();
  await expect(component.getByTestId("titles")).toContainText("a-film");
});

test("pages fetched after a cache restore merge onto the restored first page", async ({
  mount,
  page,
}) => {
  const requests = await routeGraphQL(page, () =>
    filmsPage([filmEdge("c2", "f2", "Second")], {
      hasPreviousPage: true,
      hasNextPage: false,
    }),
  );

  const component = await mount(<PaginationRestoreFixture />);

  // The restored first page renders from the cache, without a request.
  await expect(component.getByTestId("titles")).toContainText('["First"]');
  expect(requests.count).toBe(0);

  await component.getByTestId("load-next").click();
  await expect(component.getByTestId("titles")).toContainText(
    '["First","Second"]',
  );
});
