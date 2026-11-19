import { expect } from "@playwright/experimental-ct-react";
import type { Page, Route } from "@playwright/test";

type Fulfill = Parameters<Route["fulfill"]>[0];

// Answers every GraphQL request with `respond`, called with the request
// variables and its index in arrival order. Returns the request counter.
export const routeGraphQL = async <Variables>(
  page: Page,
  respond: (variables: Variables, index: number) => Fulfill | Promise<Fulfill>,
): Promise<{ readonly count: number }> => {
  const requests = { count: 0 };

  await page.route("**/graphql", async (route) => {
    const index = requests.count++;
    const body = route.request().postDataJSON() as { variables: Variables };
    await route.fulfill(await respond(body.variables, index));
  });

  return requests;
};

// Holds each request open until the test releases its key, so the test
// controls the order responses arrive in.
export const createRequestGate = () => {
  const pending = new Map<string, () => void>();

  const waitFor = async (key: string): Promise<void> => {
    await expect.poll(() => pending.has(key)).toBe(true);
  };

  return {
    wait: (key: string): Promise<void> =>
      new Promise((resolve) => {
        pending.set(key, resolve);
      }),

    waitFor,

    release: async (key: string): Promise<void> => {
      await waitFor(key);
      pending.get(key)?.();
    },
  };
};

export const graphQLError = (message: string): Fulfill => ({
  json: { errors: [{ message }] },
});
