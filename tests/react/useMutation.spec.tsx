import { expect, test } from "@playwright/experimental-ct-react";
import { MutationFixture } from "./fixtures/MutationFixture";
import { typedDoc } from "./typedDoc";

type GreetData = { greet: string };
type GreetVariables = { id: string };

const GreetMutation = typedDoc<GreetData, GreetVariables>(
  `mutation Greet($id: ID!) { greet(id: $id) }`,
);

test("starts idle", async ({ mount }) => {
  const component = await mount(
    <MutationFixture url="/graphql" mutation={GreetMutation} />,
  );

  await expect(component.getByTestId("state")).toContainText(
    JSON.stringify({ status: "idle", fetching: false }),
  );
});

test("a successful mutation resolves to a success state", async ({
  mount,
  page,
}) => {
  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: GreetVariables;
    };
    await route.fulfill({
      json: { data: { greet: `hi-${body.variables.id}` } },
    });
  });

  const component = await mount(
    <MutationFixture url="/graphql" mutation={GreetMutation} />,
  );

  await component.getByTestId("mutate-ok").click();

  await expect(component.getByTestId("state")).toContainText(
    JSON.stringify({
      status: "success",
      fetching: false,
      data: { greet: "hi-1" },
    }),
  );
});

test("a failed mutation resolves to an error state", async ({
  mount,
  page,
}) => {
  await page.route("**/graphql", async (route) => {
    await route.fulfill({ json: { errors: [{ message: "Not allowed" }] } });
  });

  const component = await mount(
    <MutationFixture url="/graphql" mutation={GreetMutation} />,
  );

  await component.getByTestId("mutate-fail").click();

  await expect(component.getByTestId("state")).toContainText("Not allowed");
  await expect(component.getByTestId("state")).toContainText(
    '"status":"error"',
  );
});

test("only the most recently started call's result is reflected in state", async ({
  mount,
  page,
}) => {
  const release = new Map<string, () => void>();

  await page.route("**/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      variables: GreetVariables;
    };
    const id = body.variables.id;

    await new Promise<void>((resolve) => release.set(id, resolve));

    if (id === "bad") {
      await route.fulfill({ json: { errors: [{ message: "Not allowed" }] } });
    } else {
      await route.fulfill({ json: { data: { greet: `hi-${id}` } } });
    }
  });

  const component = await mount(
    <MutationFixture url="/graphql" mutation={GreetMutation} />,
  );

  // Start the "ok" call first, then the "fail" call before "ok" resolves.
  await component.getByTestId("mutate-ok").click();
  await expect.poll(() => release.has("1")).toBe(true);

  await component.getByTestId("mutate-fail").click();
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
