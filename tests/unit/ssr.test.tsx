import { expect, test } from "bun:test";

import { Suspense } from "react";
import { renderToString } from "react-dom/server";

import { transformDocument } from "../../src/graphql/transform";
import { ClientProvider } from "../../src/react/context";
import { useQuery } from "../../src/react/useQuery";
import { createClient, GreetingQuery } from "../shared";

const Greeting = (): React.ReactNode => {
  const [state] = useQuery(GreetingQuery, { id: "1" });
  return <div>{state.data.greeting}</div>;
};

test("a prefetched query renders on the server", () => {
  const client = createClient();

  client.cache.writeOperation(
    transformDocument(GreetingQuery),
    { __typename: "Query", greeting: "hello-ssr" },
    { id: "1" },
  );

  const html = renderToString(
    <ClientProvider value={client}>
      <Suspense fallback={<div>loading</div>}>
        <Greeting />
      </Suspense>
    </ClientProvider>,
  );

  expect(html).toContain("hello-ssr");
});

test("useQuery throws without a ClientProvider", () => {
  expect(() => renderToString(<Greeting />)).toThrow("no ClientProvider found");
});
