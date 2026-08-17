import { expect, test } from "@playwright/experimental-ct-react";

import { PaginationFixture } from "./fixtures/PaginationFixture";
import { PaginationRestoreFixture } from "./fixtures/PaginationRestoreFixture";
import { PaginationSwitchFixture } from "./fixtures/PaginationSwitchFixture";

test("useForwardPagination merges a next page into the connection's edges", async ({
  mount,
  page,
}) => {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: { after?: string };
    };

    const isFirstPage = body.variables.after == null;

    await route.fulfill({
      json: {
        data: {
          films: {
            __typename: "FilmsConnection",
            edges: isFirstPage
              ? [
                  {
                    __typename: "FilmsEdge",
                    cursor: "c1",
                    node: { __typename: "Film", id: "f1", title: "A New Hope" },
                  },
                  {
                    __typename: "FilmsEdge",
                    cursor: "c2",
                    node: {
                      __typename: "Film",
                      id: "f2",
                      title: "Empire Strikes Back",
                    },
                  },
                ]
              : [
                  {
                    __typename: "FilmsEdge",
                    cursor: "c3",
                    node: {
                      __typename: "Film",
                      id: "f3",
                      title: "Return of the Jedi",
                    },
                  },
                ],
            pageInfo: isFirstPage
              ? {
                  hasPreviousPage: false,
                  hasNextPage: true,
                  startCursor: "c1",
                  endCursor: "c2",
                }
              : {
                  hasPreviousPage: true,
                  hasNextPage: false,
                  startCursor: "c3",
                  endCursor: "c3",
                },
          },
        },
      },
    });
  });

  const component = await mount(<PaginationFixture url="/graphql" />);

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
  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: { era: string };
    };
    const era = body.variables.era;

    await route.fulfill({
      json: {
        data: {
          __typename: "Query",
          films: {
            __typename: "FilmsConnection",
            edges: [
              {
                __typename: "FilmsEdge",
                cursor: `${era}-c1`,
                node: {
                  __typename: "Film",
                  id: `${era}-f1`,
                  title: `${era}-film`,
                },
              },
            ],
            pageInfo: {
              hasPreviousPage: false,
              hasNextPage: true,
              startCursor: `${era}-c1`,
              endCursor: `${era}-c1`,
            },
          },
        },
      },
    });
  });

  const component = await mount(<PaginationSwitchFixture url="/graphql" />);

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
  let requestCount = 0;

  await page.route("**/graphql", async (route) => {
    requestCount++;

    await route.fulfill({
      json: {
        data: {
          __typename: "Query",
          films: {
            __typename: "FilmsConnection",
            edges: [
              {
                __typename: "FilmsEdge",
                cursor: "c2",
                node: { __typename: "Film", id: "f2", title: "Second" },
              },
            ],
            pageInfo: {
              hasPreviousPage: true,
              hasNextPage: false,
              startCursor: "c2",
              endCursor: "c2",
            },
          },
        },
      },
    });
  });

  const component = await mount(<PaginationRestoreFixture url="/graphql" />);

  // The restored first page renders from the cache, without a request.
  await expect(component.getByTestId("titles")).toContainText('["First"]');
  expect(requestCount).toBe(0);

  await component.getByTestId("load-next").click();
  await expect(component.getByTestId("titles")).toContainText(
    '["First","Second"]',
  );
});
