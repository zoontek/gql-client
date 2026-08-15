import { expect, test } from "bun:test";

import { Client } from "../../src/client/client";
import { ClientError } from "../../src/client/errors";
import { brandingQuery } from "./data";

test("ClientError has reason 'options' when requestOptions throws synchronously", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    requestOptions: () => {
      throw new Error("boom");
    },
  });

  const result = client.query(brandingQuery, {
    projectId: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "options" });
});

test("ClientError has reason 'options' when requestOptions rejects", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    requestOptions: async () => {
      throw new Error("boom");
    },
  });

  const result = client.mutate(brandingQuery, {
    projectId: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "options" });
});

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("query reuses settled requests and only refreshes on demand", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (async () => {
    fetchCount++;
    return jsonResponse({ __typename: "Query" });
  }) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });
    const variables = { projectId: "p1" };

    const first = client.query(brandingQuery, variables);
    // A concurrent call joins the in-flight request.
    expect(client.query(brandingQuery, variables)).toBe(first);

    await first;

    // The settled request is reused: a cache read that still misses after
    // the write must not fire a new network request.
    expect(client.query(brandingQuery, variables)).toBe(first);
    expect(fetchCount).toBe(1);

    // refresh replaces the settled request.
    const refreshed = client.query(brandingQuery, variables, {
      refresh: true,
    });
    expect(refreshed).not.toBe(first);

    await refreshed;
    expect(fetchCount).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("query drops rejected requests so a retry fetches again", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });
    const variables = { projectId: "p1" };

    const first = client.query(brandingQuery, variables);
    await expect(first).rejects.toBeInstanceOf(ClientError);

    const second = client.query(brandingQuery, variables);
    expect(second).not.toBe(first);

    await expect(second).rejects.toBeInstanceOf(ClientError);
    expect(fetchCount).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("purge clears stored requests and notifies subscribers", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    jsonResponse({ __typename: "Query" })) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });
    const variables = { projectId: "p1" };

    let notified = 0;
    client.subscribe(() => {
      notified++;
    });

    const first = client.query(brandingQuery, variables);
    await first;

    const before = notified;
    const versionBefore = client.getVersion();

    client.purge();

    expect(notified).toBe(before + 1);
    expect(client.getVersion()).toBeGreaterThan(versionBefore);
    // A stored settled request must not survive a purge.
    expect(client.query(brandingQuery, variables)).not.toBe(first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refetch re-sends registered queries once, until unregistered", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (async () => {
    fetchCount++;
    return jsonResponse({ __typename: "Query" });
  }) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });
    const variables = { projectId: "p1" };

    // The same query mounted twice must be sent a single time.
    const unregisterFirst = client.registerQuery(brandingQuery, variables);
    const unregisterSecond = client.registerQuery(brandingQuery, variables);

    await client.query(brandingQuery, variables);
    expect(fetchCount).toBe(1);

    await client.refetch();
    expect(fetchCount).toBe(2);

    unregisterFirst();
    unregisterSecond();

    await client.refetch();
    expect(fetchCount).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
