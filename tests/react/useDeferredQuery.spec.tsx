import { expect, test } from "@playwright/experimental-ct-react";

import { DeferredQueryFixture } from "./fixtures/DeferredQueryFixture";
import { gql } from "./gql";

type GreetingData = { greeting: string };
type GreetingVariables = { id: string };

const GreetingQuery = gql<GreetingData, GreetingVariables>(
  `query Greeting($id: ID!) { greeting(id: $id) }`,
);

test("starts idle and doesn't send a request", async ({ mount, page }) => {
  let requestCount = 0;

  await page.route("**/graphql", async (route) => {
    requestCount++;
    await route.fulfill({ json: { data: { greeting: "unused" } } });
  });

  const component = await mount(
    <DeferredQueryFixture url="/graphql" query={GreetingQuery} />,
  );

  await expect(component.getByTestId("state")).toContainText(
    JSON.stringify({ status: "idle", fetching: false }),
  );

  expect(requestCount).toBe(0);
});

test("a successful query resolves to a success state", async ({
  mount,
  page,
}) => {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: GreetingVariables;
    };
    await route.fulfill({
      json: { data: { greeting: `hello-${body.variables.id}` } },
    });
  });

  const component = await mount(
    <DeferredQueryFixture url="/graphql" query={GreetingQuery} />,
  );

  await component.getByTestId("query-ok").click();

  await expect(component.getByTestId("state")).toContainText(
    JSON.stringify({
      status: "success",
      fetching: false,
      data: { greeting: "hello-1" },
    }),
  );
});

test("a failed query resolves to an error state", async ({ mount, page }) => {
  await page.route("**/graphql", async (route) => {
    await route.fulfill({ json: { errors: [{ message: "Not found" }] } });
  });

  const component = await mount(
    <DeferredQueryFixture url="/graphql" query={GreetingQuery} />,
  );

  await component.getByTestId("query-fail").click();

  await expect(component.getByTestId("state")).toContainText("Not found");
  await expect(component.getByTestId("state")).toContainText(
    '"status":"error"',
  );
});

test("only the most recently started call's result is reflected in state", async ({
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

    if (id === "bad") {
      await route.fulfill({ json: { errors: [{ message: "Not found" }] } });
    } else {
      await route.fulfill({ json: { data: { greeting: `hello-${id}` } } });
    }
  });

  const component = await mount(
    <DeferredQueryFixture url="/graphql" query={GreetingQuery} />,
  );

  // Start the "ok" call first, then the "fail" call before "ok" resolves.
  await component.getByTestId("query-ok").click();
  await expect.poll(() => release.has("1")).toBe(true);

  await component.getByTestId("query-fail").click();
  await expect.poll(() => release.has("bad")).toBe(true);

  // Resolve the older ("ok") call last: if it clobbered state, this would
  // flip the final state back to "success".
  release.get("bad")?.();
  await expect(component.getByTestId("state")).toContainText(
    '"status":"error"',
  );

  release.get("1")?.();
  await expect(component.getByTestId("state")).toContainText(
    '"status":"error"',
  );
});
