import { expect, test } from "@playwright/experimental-ct-react";
import { StrictMode } from "react";

import {
  gql,
  GreetingQuery,
  type GreetingData,
  type GreetingVariables,
} from "../shared";
import { QueryFixture } from "./fixtures/QueryFixture";
import { createRequestGate, graphQLError, routeGraphQL } from "./helpers";

const greeting = (greeting: string) => ({ json: { data: { greeting } } });

const fixture = <QueryFixture query={GreetingQuery} variables={{ id: "1" }} />;

test("loads data over the network and exposes it", async ({ mount, page }) => {
  await routeGraphQL<GreetingVariables>(page, ({ id }) =>
    greeting(`hello-${id}`),
  );

  const component = await mount(fixture);

  await expect(component.getByTestId("state")).toContainText(
    JSON.stringify({ fetching: false, data: { greeting: "hello-1" } }),
  );
});

test("setVariables refetches while keeping previous data visible", async ({
  mount,
  page,
}) => {
  const gate = createRequestGate();

  await routeGraphQL<GreetingVariables>(page, async ({ id }) => {
    await gate.wait(id);
    return greeting(`hello-${id}`);
  });

  const component = await mount(fixture);
  const state = component.getByTestId("state");

  await gate.release("1");
  await expect(state).toContainText("hello-1");

  await component.getByTestId("set-id-2").click();
  await expect(state).toContainText('"fetching":true');
  await expect(state).toContainText("hello-1");

  await gate.release("2");
  await expect(state).toContainText(
    JSON.stringify({ fetching: false, data: { greeting: "hello-2" } }),
  );
});

test("a query error after a variable change is thrown to the nearest ErrorBoundary", async ({
  mount,
  page,
}) => {
  await routeGraphQL<GreetingVariables>(page, ({ id }) =>
    id === "bad" ? graphQLError("Not found") : greeting(`hello-${id}`),
  );

  const component = await mount(fixture);
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
  // Requests are keyed by arrival order, so the test can release the initial
  // load and the refetch independently even though both use the same
  // variables.
  const gate = createRequestGate();

  await routeGraphQL<GreetingVariables>(page, async (_variables, index) => {
    await gate.wait(String(index));
    return greeting(`hello-1-v${index + 1}`);
  });

  const component = await mount(fixture);
  const state = component.getByTestId("state");

  await gate.release("0");
  await expect(state).toContainText("hello-1-v1");

  await component.getByTestId("refetch").click();
  await expect(state).toContainText('"fetching":true');
  await expect(state).toContainText("hello-1-v1");

  await gate.release("1");
  await expect(state).toContainText(
    JSON.stringify({ fetching: false, data: { greeting: "hello-1-v2" } }),
  );
});

test("a failed refetch is thrown to the nearest ErrorBoundary", async ({
  mount,
  page,
}) => {
  await routeGraphQL(page, (_variables, index) =>
    index === 0 ? greeting("hello-1") : graphQLError("Not found"),
  );

  const component = await mount(fixture);
  await expect(component.getByTestId("state")).toContainText("hello-1");

  await component.getByTestId("refetch").click();
  await expect(page.getByTestId("error")).toContainText("Not found");
});

test("Client#refetch re-sends every mounted query", async ({ mount, page }) => {
  await routeGraphQL(page, (_variables, index) =>
    greeting(`hello-${index + 1}`),
  );

  const component = await mount(fixture);
  await expect(component.getByTestId("state")).toContainText("hello-1");

  await component.getByTestId("refetch-all").click();
  await expect(component.getByTestId("state")).toContainText("hello-2");
});

test("a missing fragment is thrown to the nearest ErrorBoundary as a ClientError", async ({
  mount,
}) => {
  const BrokenQuery = gql<GreetingData, GreetingVariables>(
    `query Greeting($id: ID!) { greeting(id: $id) ...Missing }`,
  );

  const component = await mount(
    <QueryFixture query={BrokenQuery} variables={{ id: "1" }} />,
  );

  await expect(component.getByTestId("error")).toContainText(
    "failed with an unknown error",
  );
});

for (const strict of [false, true]) {
  test(`a failed first load is thrown to the nearest ErrorBoundary after 1 request${strict ? " (Strict Mode)" : ""}`, async ({
    mount,
    page,
  }) => {
    const requests = await routeGraphQL(page, () => ({
      status: 500,
      body: "nope",
    }));

    const component = await mount(
      strict ? <StrictMode>{fixture}</StrictMode> : fixture,
    );

    await expect(component.getByTestId("error")).toContainText("status 500");

    // No other request arrives later.
    await page.waitForTimeout(200);
    expect(requests.count).toBe(1);

    // A reset of the ErrorBoundary sends a new request.
    await component.getByTestId("reset").click();
    await expect(component.getByTestId("error")).toContainText("status 500");
    expect(requests.count).toBe(2);
  });
}
