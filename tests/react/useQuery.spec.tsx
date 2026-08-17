import { expect, test } from "@playwright/experimental-ct-react";

import { QueryFixture } from "./fixtures/QueryFixture";
import { RefetchFixture } from "./fixtures/RefetchFixture";
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

test("a query error after a variable change is thrown to the nearest ErrorBoundary", async ({
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

test("refetch re-sends the request, keeping fetching: true and the previous data visible", async ({
  mount,
  page,
}) => {
  let requestCount = 0;
  // One resolver per incoming request, in arrival order, so the test can
  // release the initial load and the refetch independently even though both
  // use the same variables.
  const release: Array<() => void> = [];

  await page.route("**/graphql", async (route) => {
    const count = ++requestCount;
    await new Promise<void>((resolve) => release.push(resolve));

    await route.fulfill({
      json: { data: { greeting: `hello-1-v${count}` } },
    });
  });

  const component = await mount(
    <QueryFixture
      url="/graphql"
      query={GreetingQuery}
      variables={{ id: "1" }}
    />,
  );

  await expect.poll(() => release.length).toBe(1);
  release[0]?.();
  const state = component.getByTestId("state");
  await expect(state).toContainText("hello-1-v1");

  await component.getByTestId("refetch").click();
  await expect(state).toContainText('"fetching":true');
  await expect(state).toContainText("hello-1-v1");

  await expect.poll(() => release.length).toBe(2);
  release[1]?.();
  await expect(state).toContainText(
    JSON.stringify({ fetching: false, data: { greeting: "hello-1-v2" } }),
  );
});

test("a failed refetch is thrown to the nearest ErrorBoundary", async ({
  mount,
  page,
}) => {
  let requestCount = 0;

  await page.route("**/graphql", async (route) => {
    requestCount++;

    if (requestCount === 1) {
      await route.fulfill({ json: { data: { greeting: "hello-1" } } });
    } else {
      await route.fulfill({ json: { errors: [{ message: "Not found" }] } });
    }
  });

  const component = await mount(
    <QueryFixture
      url="/graphql"
      query={GreetingQuery}
      variables={{ id: "1" }}
    />,
  );

  await expect(component.getByTestId("state")).toContainText("hello-1");

  await component.getByTestId("refetch").click();
  await expect(page.getByTestId("error")).toContainText("Not found");
});

test("Client#refetch re-sends every mounted query", async ({ mount, page }) => {
  let requestCount = 0;

  await page.route("**/graphql", async (route) => {
    requestCount++;

    await route.fulfill({
      json: { data: { greeting: `hello-${requestCount}` } },
    });
  });

  const component = await mount(<RefetchFixture url="/graphql" />);
  await expect(component.getByTestId("state")).toContainText("hello-1");

  await component.getByTestId("refetch-all").click();
  await expect(component.getByTestId("state")).toContainText("hello-2");
});
