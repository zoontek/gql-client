import { expect, test } from "@playwright/experimental-ct-react";

import { QueryFixture } from "./fixtures/QueryFixture";
import { gql } from "./gql";

type GreetingData = { greeting: string };
type GreetingVariables = { id: string };

const GreetingQuery = gql<GreetingData, GreetingVariables>(
  `query Greeting($id: ID!) { greeting(id: $id) }`,
);

test("loads data over the network and exposes it", async ({ mount, page }) => {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: GreetingVariables;
    };

    await route.fulfill({
      json: { data: { greeting: `hello-${body.variables.id}` } },
    });
  });

  const component = await mount(
    <QueryFixture
      url="/graphql"
      query={GreetingQuery}
      variables={{ id: "1" }}
    />,
  );

  await expect(component.getByTestId("state")).toContainText(
    JSON.stringify({ fetching: false, data: { greeting: "hello-1" } }),
  );
});

test("setVariables refetches while keeping previous data visible", async ({
  mount,
  page,
}) => {
  // Holds each request open until the test calls release.get(id)(), so we
  // control the order responses arrive in.
  const release = new Map<string, () => void>();

  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: GreetingVariables;
    };
    const id = body.variables.id;

    await new Promise<void>((resolve) => release.set(id, resolve));

    await route.fulfill({
      json: { data: { greeting: `hello-${id}` } },
    });
  });

  const component = await mount(
    <QueryFixture
      url="/graphql"
      query={GreetingQuery}
      variables={{ id: "1" }}
    />,
  );

  await expect.poll(() => release.has("1")).toBe(true);
  release.get("1")?.();
  const state = component.getByTestId("state");
  await expect(state).toContainText("hello-1");

  await component.getByTestId("set-id-2").click();
  await expect(state).toContainText('"fetching":true');
  await expect(state).toContainText("hello-1");

  await expect.poll(() => release.has("2")).toBe(true);
  release.get("2")?.();
  await expect(state).toContainText(
    JSON.stringify({ fetching: false, data: { greeting: "hello-2" } }),
  );
});

test("a refetch's GraphQL error is thrown to the nearest ErrorBoundary", async ({
  mount,
  page,
}) => {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: GreetingVariables;
    };

    if (body.variables.id === "bad") {
      await route.fulfill({ json: { errors: [{ message: "Not found" }] } });
      return;
    }

    await route.fulfill({
      json: { data: { greeting: `hello-${body.variables.id}` } },
    });
  });

  const component = await mount(
    <QueryFixture
      url="/graphql"
      query={GreetingQuery}
      variables={{ id: "1" }}
    />,
  );

  await expect(component.getByTestId("state")).toContainText("hello-1");

  await component.getByTestId("set-id-bad").click();
  // Queried from `page`, not `component`: react-error-boundary recovers by
  // fully recreating the tree, which can detach Playwright's handle on the
  // originally mounted root.
  await expect(page.getByTestId("error")).toContainText("Not found");
});
