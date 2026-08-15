import { expect, test } from "bun:test";

import { Suspense } from "react";
import { renderToString } from "react-dom/server";

import { Client } from "../../src/client/client";
import { transformDocument } from "../../src/graphql/transform";
import { ClientProvider } from "../../src/react/context";
import { useQuery } from "../../src/react/useQuery";
import { gql } from "../react/gql";

type GreetingData = { greeting: string };
type GreetingVariables = { id: string };

const GreetingQuery = gql<GreetingData, GreetingVariables>(
  `query Greeting($id: ID!) { greeting(id: $id) }`,
);

const createClient = (): Client =>
  new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
  });

test("a prefetched query renders on the server", () => {
  const client = createClient();

  client.cache.writeOperation(
    transformDocument(GreetingQuery),
    { __typename: "Query", greeting: "hello-ssr" },
    { id: "1" },
  );

  const App = (): React.ReactNode => {
    const [state] = useQuery(GreetingQuery, { id: "1" });
    return <div>{state.data.greeting}</div>;
  };

  const html = renderToString(
    <ClientProvider value={client}>
      <Suspense fallback={<div>loading</div>}>
        <App />
      </Suspense>
    </ClientProvider>,
  );

  expect(html).toContain("hello-ssr");
});

test("extract/restore round-trips the cache through JSON", () => {
  type ProjectData = {
    project: {
      id: string;
      name: string;
      metadata: { $sym: string; nested: { tags: (string | null)[] } };
      members: ({ id: string; name: string } | null)[];
    };
  };

  const ProjectQuery = gql<ProjectData, { id: string }>(
    `query Project($id: ID!) {
      project(id: $id) {
        id
        name
        metadata
        members { id name }
      }
    }`,
  );

  const response = {
    __typename: "Query",
    project: {
      __typename: "Project",
      id: "p1",
      name: "</script><script>alert(1)</script>",
      // A custom scalar colliding with a serialization marker key.
      metadata: { $sym: "collision", nested: { tags: ["a", null] } },
      members: [
        { __typename: "User", id: "u1", name: "Ada" },
        null,
        { __typename: "User", id: "u2", name: "Grace" },
      ],
    },
  };

  const source = createClient();
  const document = transformDocument(ProjectQuery);
  const variables = { id: "p1" };

  source.cache.writeOperation(document, response, variables);

  const serialized = source.extract();

  // Script-safe: no raw "<" survives, so "</script>" can't break the tag.
  expect(serialized).not.toContain("<");
  expect(JSON.parse(serialized)).toEqual(
    JSON.parse(JSON.stringify(JSON.parse(serialized))),
  );

  const target = createClient();
  target.restore(serialized);

  expect(target.cache.readOperation(document, variables)).toEqual(
    source.cache.readOperation(document, variables),
  );
  expect(target.cache.readOperation(document, variables)).toMatchObject({
    project: {
      id: "p1",
      name: "</script><script>alert(1)</script>",
      metadata: { $sym: "collision", nested: { tags: ["a", null] } },
      members: [{ name: "Ada" }, null, { name: "Grace" }],
    },
  });
});

test("restore notifies subscribers and bumps the version", () => {
  const source = createClient();

  source.cache.writeOperation(
    transformDocument(GreetingQuery),
    { __typename: "Query", greeting: "hello-ssr" },
    { id: "1" },
  );

  const target = createClient();
  let notified = 0;
  target.subscribe(() => {
    notified++;
  });

  const versionBefore = target.getVersion();
  target.restore(source.extract());

  expect(notified).toBe(1);
  expect(target.getVersion()).toBeGreaterThan(versionBefore);
});
