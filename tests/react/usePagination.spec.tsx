import { expect, test } from "@playwright/experimental-ct-react";

import { PaginationFixture } from "./fixtures/PaginationFixture";

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
