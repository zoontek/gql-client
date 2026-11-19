import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { expect, test } from "@playwright/experimental-ct-react";

import { gql, GreetingQuery, type GreetingVariables } from "../shared";
import { AsyncOperationFixture } from "./fixtures/AsyncOperationFixture";
import { createRequestGate, graphQLError, routeGraphQL } from "./helpers";

const GreetMutation = gql<{ greet: string }, GreetingVariables>(
  `mutation Greet($id: ID!) { greet(id: $id) }`,
);

const hooks: {
  hook: "useMutation" | "useDeferredQuery";
  document: TypedDocumentNode<unknown, GreetingVariables>;
  respond: (variables: GreetingVariables) => unknown;
}[] = [
  {
    hook: "useMutation",
    document: GreetMutation,
    respond: ({ id }: GreetingVariables) => ({ greet: `hi-${id}` }),
  },
  {
    hook: "useDeferredQuery",
    document: GreetingQuery,
    respond: ({ id }: GreetingVariables) => ({ greeting: `hello-${id}` }),
  },
];

for (const { hook, document, respond } of hooks) {
  test.describe(hook, () => {
    const fixture = <AsyncOperationFixture hook={hook} document={document} />;

    test("starts idle and doesn't send a request", async ({ mount, page }) => {
      const requests = await routeGraphQL<GreetingVariables>(
        page,
        (variables) => ({ json: { data: respond(variables) } }),
      );

      const component = await mount(fixture);

      await expect(component.getByTestId("state")).toContainText(
        JSON.stringify({ status: "idle", fetching: false }),
      );
      expect(requests.count).toBe(0);
    });

    test("a successful call resolves to a success state", async ({
      mount,
      page,
    }) => {
      await routeGraphQL<GreetingVariables>(page, (variables) => ({
        json: { data: respond(variables) },
      }));

      const component = await mount(fixture);
      await component.getByTestId("run-ok").click();

      await expect(component.getByTestId("state")).toContainText(
        JSON.stringify({
          status: "success",
          fetching: false,
          data: respond({ id: "1" }),
        }),
      );
    });

    test("a failed call resolves to an error state", async ({
      mount,
      page,
    }) => {
      await routeGraphQL(page, () => graphQLError("Not allowed"));

      const component = await mount(fixture);
      await component.getByTestId("run-fail").click();

      const state = component.getByTestId("state");
      await expect(state).toContainText("Not allowed");
      await expect(state).toContainText('"status":"error"');
    });

    test("only the most recently started call's result is reflected in state", async ({
      mount,
      page,
    }) => {
      const gate = createRequestGate();

      await routeGraphQL<GreetingVariables>(page, async (variables) => {
        await gate.wait(variables.id);

        return variables.id === "bad"
          ? graphQLError("Not allowed")
          : { json: { data: respond(variables) } };
      });

      const component = await mount(fixture);
      const state = component.getByTestId("state");

      // Start the "ok" call first, then the "fail" call before "ok" resolves.
      await component.getByTestId("run-ok").click();
      await gate.waitFor("1");

      await component.getByTestId("run-fail").click();
      await gate.waitFor("bad");

      // Resolve the older ("ok") call last: if it clobbered state, this would
      // flip the final state back to "success".
      await gate.release("bad");
      await expect(state).toContainText('"status":"error"');

      await gate.release("1");
      await expect(state).toContainText('"status":"error"');
    });
  });
}
