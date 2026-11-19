import { afterEach, expect, setSystemTime, test } from "bun:test";

import { parse } from "@0no-co/graphql.web";

import { ClientError } from "../../src/client/errors";
import { transformDocument } from "../../src/graphql/transform";
import { createClient, gql, GreetingQuery } from "../shared";
import { jsonResponse, mockFetch, restoreFetch } from "./helpers";

afterEach(() => {
  restoreFetch();
  setSystemTime();
});

const variables = { id: "1" };

// Counts the requests, and answers each one with `body`. A bare Query
// response lets the cache read nothing back for GreetingQuery.
const countRequests = (
  body: unknown = { data: { __typename: "Query" } },
  init?: ResponseInit,
): { readonly count: number } => {
  const counter = { count: 0 };

  mockFetch(() => {
    counter.count++;
    return jsonResponse(body, init);
  });

  return counter;
};

const countNotifications = (
  client: ReturnType<typeof createClient>,
): { readonly count: number } => {
  const counter = { count: 0 };

  client.subscribe(() => {
    counter.count++;
  });

  return counter;
};

test("transformRequest receives the built request and its result is sent", async () => {
  let sent: Request | undefined;
  let seenBody: string | undefined;

  mockFetch((request) => {
    sent = request;
    return jsonResponse({ data: { __typename: "Query" } });
  });

  const client = createClient({
    transformRequest: async (request) => {
      seenBody = await request.clone().text();
      request.headers.set("Authorization", "Bearer token");
      return request;
    },
  });

  await client.query(GreetingQuery, variables);

  expect(sent?.method).toBe("POST");
  expect(sent?.url).toBe("http://localhost/graphql");
  expect(sent?.headers.get("Authorization")).toBe("Bearer token");
  expect(sent?.headers.get("Content-Type")).toBe("application/json");
  expect(sent?.signal).toBeDefined();

  // The transform sees the exact body that gets sent.
  expect(JSON.parse(seenBody ?? "")).toMatchObject({
    operationName: "Greeting",
    variables,
  });

  expect(await sent?.text()).toBe(seenBody);
});

test("query keeps a settled request the cache can't read, and only refreshes on demand", async () => {
  const requests = countRequests();
  const client = createClient();

  const first = client.query(GreetingQuery, variables);
  // A concurrent call joins the in-flight request.
  expect(client.query(GreetingQuery, variables)).toBe(first);

  await first;

  // The settled request is reused: a cache read that still misses after
  // the write must not fire a new network request.
  expect(client.query(GreetingQuery, variables)).toBe(first);
  expect(requests.count).toBe(1);

  // refresh replaces the settled request.
  const refreshed = client.query(GreetingQuery, variables, { refresh: true });
  expect(refreshed).not.toBe(first);

  await refreshed;
  expect(requests.count).toBe(2);
});

test("query drops a settled request once the cache can read its response", async () => {
  const requests = countRequests({
    data: { __typename: "Query", greeting: "hello" },
  });
  const client = createClient();

  const first = client.query(GreetingQuery, variables);
  await first;

  const second = client.query(GreetingQuery, variables);
  expect(second).not.toBe(first);

  await second;
  expect(requests.count).toBe(2);
});

test("query drops rejected requests so a retry fetches again", async () => {
  const requests = countRequests("nope", { status: 500 });
  const client = createClient();

  const first = client.query(GreetingQuery, variables);
  await expect(first).rejects.toBeInstanceOf(ClientError);

  const second = client.query(GreetingQuery, variables);
  expect(second).not.toBe(first);

  await expect(second).rejects.toBeInstanceOf(ClientError);
  expect(requests.count).toBe(2);
});

test("a rejected suspense request is kept for 1 second at most", async () => {
  const requests = countRequests("nope", { status: 500 });
  const client = createClient();
  const options = { suspense: true };

  const first = client.query(GreetingQuery, variables, options);
  await expect(first).rejects.toBeInstanceOf(ClientError);

  // The render React runs right after the rejection gets it back, then it
  // is dropped.
  expect(client.query(GreetingQuery, variables, options)).toBe(first);
  await Promise.resolve();

  const second = client.query(GreetingQuery, variables, options);
  await expect(second).rejects.toBeInstanceOf(ClientError);
  expect(requests.count).toBe(2);

  // Nothing asks for `second`, as if its component unmounted, so it
  // expires.
  setSystemTime(new Date(Date.now() + 2000));
  const third = client.query(GreetingQuery, variables, options);
  expect(third).not.toBe(second);

  await expect(third).rejects.toBeInstanceOf(ClientError);
  expect(requests.count).toBe(3);
});

test("refetch re-sends registered queries once, until unregistered", async () => {
  const requests = countRequests();
  const client = createClient();

  // The same query mounted twice must be sent a single time.
  const unregisterFirst = client.registerQuery(GreetingQuery, variables);
  const unregisterSecond = client.registerQuery(GreetingQuery, variables);

  await client.query(GreetingQuery, variables);
  expect(requests.count).toBe(1);

  await client.refetch();
  expect(requests.count).toBe(2);

  unregisterFirst();
  unregisterSecond();

  await client.refetch();
  expect(requests.count).toBe(2);
});

test("purge clears stored requests and notifies subscribers", async () => {
  countRequests();
  const client = createClient();
  const notifications = countNotifications(client);

  const first = client.query(GreetingQuery, variables);
  await first;

  const notifiedBefore = notifications.count;
  const versionBefore = client.getVersion();

  client.purge();

  expect(notifications.count).toBe(notifiedBefore + 1);
  expect(client.getVersion()).toBeGreaterThan(versionBefore);
  // A stored settled request must not survive a purge.
  expect(client.query(GreetingQuery, variables)).not.toBe(first);
});

test("restore notifies subscribers and bumps the version", () => {
  const source = createClient();

  source.cache.writeOperation(
    transformDocument(GreetingQuery),
    { __typename: "Query", greeting: "hello-ssr" },
    variables,
  );

  const target = createClient();
  const notifications = countNotifications(target);
  const versionBefore = target.getVersion();

  target.restore(source.extract());

  expect(notifications.count).toBe(1);
  expect(target.getVersion()).toBeGreaterThan(versionBefore);
});

test.each(["purge", "restore"] as const)(
  "a response that arrives after %s is not written to the cache",
  async (reset) => {
    let release: (() => void) | undefined;

    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(
              jsonResponse({
                data: {
                  __typename: "Query",
                  me: { __typename: "User", id: "1", name: "Alice" },
                },
              }),
            );
          };
        }),
    );

    const client = createClient();
    const notifications = countNotifications(client);

    const pending = client.query(parse(`query Me { me { id name } }`), {});
    while (release == null) {
      await Promise.resolve();
    }

    if (reset === "purge") {
      client.purge();
    } else {
      client.restore({ entries: [] });
    }

    const notifiedAfterReset = notifications.count;
    release();

    await expect(pending).resolves.toMatchObject({ me: { name: "Alice" } });
    expect(client.cache.dump().size).toBe(0);
    expect(notifications.count).toBe(notifiedAfterReset);
  },
);

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
  const projectVariables = { id: "p1" };

  source.cache.writeOperation(document, response, projectVariables);

  const serialized = source.extract();

  // Script-safe: no raw "<" survives, so "</script>" can't break the tag.
  expect(serialized).not.toContain("<");
  expect(JSON.parse(serialized)).toEqual(
    JSON.parse(JSON.stringify(JSON.parse(serialized))),
  );

  const target = createClient();
  target.restore(serialized);

  expect(target.cache.readOperation(document, projectVariables)).toEqual(
    source.cache.readOperation(document, projectVariables),
  );
  expect(target.cache.readOperation(document, projectVariables)).toMatchObject({
    project: {
      id: "p1",
      name: "</script><script>alert(1)</script>",
      metadata: { $sym: "collision", nested: { tags: ["a", null] } },
      members: [{ name: "Ada" }, null, { name: "Grace" }],
    },
  });
});
