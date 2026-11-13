import { expect, setSystemTime, test } from "bun:test";

import { parse } from "@0no-co/graphql.web";

import { Client } from "../../src/client/client";
import { ClientError } from "../../src/client/errors";
import { brandingQuery } from "./data";

test("ClientError has reason 'unknown' when transformRequest throws synchronously", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    transformRequest: () => {
      throw new Error("boom");
    },
  });

  const result = client.query(brandingQuery, {
    projectId: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "unknown" });
});

test("ClientError has reason 'unknown' when transformRequest rejects", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    transformRequest: async () => {
      throw new Error("boom");
    },
  });

  const result = client.mutate(brandingQuery, {
    projectId: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "unknown" });
});

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("transformRequest receives the built request and its result is sent", async () => {
  const originalFetch = globalThis.fetch;
  let sent: Request | undefined;

  globalThis.fetch = (async (request: Request) => {
    sent = request;
    return jsonResponse({ __typename: "Query" });
  }) as unknown as typeof fetch;

  try {
    let seenBody: string | undefined;

    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      transformRequest: async (request) => {
        seenBody = await request.clone().text();
        request.headers.set("Authorization", "Bearer token");
        return request;
      },
    });

    await client.query(brandingQuery, { projectId: "p1" });

    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("http://localhost/graphql");
    expect(sent?.headers.get("Authorization")).toBe("Bearer token");
    expect(sent?.headers.get("Content-Type")).toBe("application/json");
    expect(sent?.signal).toBeDefined();

    // The transform sees the exact body that gets sent.
    expect(JSON.parse(seenBody ?? "")).toMatchObject({
      operationName: "getBrandingPage",
      variables: { projectId: "p1" },
    });

    expect(await sent?.text()).toBe(seenBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("query keeps a settled request the cache can't read, and only refreshes on demand", async () => {
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

test("query drops a settled request once the cache can read its response", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = (async () => {
    fetchCount++;
    return jsonResponse({
      __typename: "Query",
      me: { __typename: "User", id: "1" },
    });
  }) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });
    const document = parse(`query Me { me { id } }`);

    const first = client.query(document, {});
    await first;

    const second = client.query(document, {});
    expect(second).not.toBe(first);

    await second;
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

test("a rejected suspense request is kept for 1 second at most", async () => {
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

    const first = client.query(brandingQuery, variables, { suspense: true });
    await expect(first).rejects.toBeInstanceOf(ClientError);

    // The render React runs right after the rejection gets it back, then it
    // is dropped.
    expect(client.query(brandingQuery, variables, { suspense: true })).toBe(
      first,
    );
    await Promise.resolve();

    const second = client.query(brandingQuery, variables, { suspense: true });
    await expect(second).rejects.toBeInstanceOf(ClientError);
    expect(fetchCount).toBe(2);

    // Nothing asks for `second`, as if its component unmounted, so it
    // expires.
    setSystemTime(new Date(Date.now() + 2000));
    const third = client.query(brandingQuery, variables, { suspense: true });
    expect(third).not.toBe(second);

    await expect(third).rejects.toBeInstanceOf(ClientError);
    expect(fetchCount).toBe(3);
  } finally {
    setSystemTime();
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

for (const reset of ["purge", "restore"] as const) {
  test(`a response that arrives after ${reset} is not written to the cache`, async () => {
    const originalFetch = globalThis.fetch;
    let release: (() => void) | undefined;

    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = () => {
          resolve(
            jsonResponse({
              __typename: "Query",
              me: { __typename: "User", id: "1", name: "Alice" },
            }),
          );
        };
      })) as unknown as typeof fetch;

    try {
      const client = new Client({
        url: "http://localhost/graphql",
        schemaConfig: { interfaceToTypes: {} },
      });
      const query = parse(`query Me { me { id name } }`);

      let notified = 0;
      client.subscribe(() => {
        notified++;
      });

      const pending = client.query(query, {});
      while (release == null) {
        await Promise.resolve();
      }

      if (reset === "purge") {
        client.purge();
      } else {
        client.restore({ entries: [] });
      }

      const notifiedAfterReset = notified;
      release();

      await expect(pending).resolves.toMatchObject({ me: { name: "Alice" } });
      expect(client.cache.dump().size).toBe(0);
      expect(notified).toBe(notifiedAfterReset);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("a fetch failure is a 'network' error caused by the fetch error", async () => {
  const originalFetch = globalThis.fetch;
  const fetchError = new TypeError("Failed to fetch");

  globalThis.fetch = (async () => {
    throw fetchError;
  }) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    const result = client.query(parse(`query Me { me { id } }`), {});

    await expect(result).rejects.toBeInstanceOf(ClientError);
    await expect(result).rejects.toMatchObject({
      reason: "network",
      cause: fetchError,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an error in connectionUpdates is an 'unknown' error, and the write is still announced", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    jsonResponse({
      __typename: "Mutation",
      addItem: { __typename: "Item", id: "1" },
    })) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });
    const callbackError = new TypeError("Cannot read properties of undefined");

    let notified = 0;
    client.subscribe(() => {
      notified++;
    });

    const result = client.mutate(
      parse(`mutation AddItem { addItem { id } }`),
      {},
      {
        connectionUpdates: [
          () => {
            throw callbackError;
          },
        ],
      },
    );

    await expect(result).rejects.toBeInstanceOf(ClientError);
    await expect(result).rejects.toMatchObject({
      reason: "unknown",
      cause: callbackError,
    });
    expect(client.cache.dump().has(Symbol.for("Item<1>"))).toBe(true);
    expect(notified).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a transformRequest error is kept as the cause", async () => {
  const transformError = new Error("boom");

  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    transformRequest: () => {
      throw transformError;
    },
  });

  await expect(
    client.mutate(parse(`mutation M { ping }`), {}),
  ).rejects.toMatchObject({ reason: "unknown", cause: transformError });
});

test("a body that isn't JSON is a 'malformed' error caused by the parse error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response("<html>Bad Gateway</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    const result = client.query(parse(`query Me { me { id } }`), {});

    await expect(result).rejects.toMatchObject({ reason: "malformed" });
    const error = await result.catch((error: unknown) => error);
    expect((error as ClientError).cause).toBeInstanceOf(SyntaxError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Some `fetch` implementations reject with a plain `AbortError` instead of
// the signal's reason, before and during the body read.
const abortError = (): DOMException =>
  new DOMException("The operation was aborted.", "AbortError");

test("a timeout before the response is a 'timeout' error, whatever fetch rejects with", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((_request: Request, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(abortError());
      });
    })) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      timeout: 10,
    });

    await expect(
      client.query(parse(`query Me { me { id } }`), {}),
    ).rejects.toMatchObject({ reason: "timeout" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a timeout during the body read is a 'timeout' error, not 'malformed'", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_request: Request, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            controller.error(abortError());
          });
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      timeout: 10,
    });

    await expect(
      client.query(parse(`query Me { me { id } }`), {}),
    ).rejects.toMatchObject({ reason: "timeout" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Rejects like `fetch` when its signal aborts, and never resolves otherwise.
const pendingFetch = ((_request: Request, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted === true) {
      reject(abortError());
      return;
    }

    init.signal?.addEventListener("abort", () => {
      reject(abortError());
    });
  })) as unknown as typeof fetch;

test("a timeout keeps the abort error as its cause", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pendingFetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      timeout: 10,
    });

    const error = await client
      .query(parse(`query Me { me { id } }`), {})
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ reason: "timeout" });
    expect((error as ClientError).cause).toBeInstanceOf(DOMException);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aborting the signal set by transformRequest is an 'aborted' error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pendingFetch;

  try {
    const controller = new AbortController();

    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      transformRequest: (request) =>
        new Request(request, { signal: controller.signal }),
    });

    const result = client.query(parse(`query Me { me { id } }`), {});
    setTimeout(() => {
      controller.abort();
    }, 5);

    await expect(result).rejects.toMatchObject({ reason: "aborted" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a signal already aborted by transformRequest is an 'aborted' error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pendingFetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      transformRequest: (request) =>
        new Request(request, { signal: AbortSignal.abort() }),
    });

    await expect(
      client.query(parse(`query Me { me { id } }`), {}),
    ).rejects.toMatchObject({ reason: "aborted" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a connection drop during the body read is a 'network' error", async () => {
  const originalFetch = globalThis.fetch;
  const dropError = new TypeError("terminated");

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          controller.error(dropError);
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    await expect(
      client.query(parse(`query Me { me { id } }`), {}),
    ).rejects.toMatchObject({ reason: "network", cause: dropError });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an error body that never ends is a 'status' error once the timeout fires", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_request: Request, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            controller.error(abortError());
          });
        },
      }),
      { status: 500 },
    )) as unknown as typeof fetch;

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
      timeout: 10,
    });

    await expect(
      client.query(parse(`query Me { me { id } }`), {}),
    ).rejects.toMatchObject({ reason: "status" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a consumed request from transformRequest is an 'unknown' error", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    transformRequest: async (request) => {
      await request.text();
      return request;
    },
  });

  const error = await client
    .mutate(parse(`mutation M { ping }`), {})
    .catch((error: unknown) => error);

  expect(error).toMatchObject({ reason: "unknown" });
  expect((error as ClientError).cause).toBeInstanceOf(TypeError);
  expect(String((error as ClientError).cause)).toContain("request.clone()");
});

const respondWith = (body: unknown, init?: ResponseInit): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    })) as unknown as typeof fetch;

test("an empty `errors` array next to `data` is not an error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = respondWith({
    data: { __typename: "Query", me: { __typename: "User", id: "1" } },
    errors: [],
  });

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    await expect(
      client.query(parse(`query Me { me { id } }`), {}),
    ).resolves.toMatchObject({ me: { id: "1" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a response with `data` and errors is a 'graphQL' error and is not written to the cache", async () => {
  const originalFetch = globalThis.fetch;
  const data = {
    __typename: "Query",
    me: { __typename: "User", id: "1", avatar: null },
  };

  globalThis.fetch = respondWith({
    data,
    errors: [{ message: "Avatar service is down", path: ["me", "avatar"] }],
  });

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    const error = await client
      .query(parse(`query Me { me { id avatar } }`), {})
      .catch((error: unknown) => error);

    expect(error).toMatchObject({
      reason: "graphQL",
      message: "Avatar service is down",
    });
    expect(client.cache.dump().size).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphQL errors with a 4xx status are a 'graphQL' error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = respondWith(
    { errors: [{ message: 'Cannot query field "nope" on type "Query".' }] },
    { status: 400 },
  );

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    const error = await client
      .query(parse(`query Q { nope }`), {})
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ reason: "graphQL" });
    expect((error as ClientError).response?.status).toBe(400);
    expect((error as ClientError).graphQLErrors[0]?.message).toContain("nope");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 4xx JSON body without GraphQL errors is a 'status' error with a readable response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = respondWith({ message: "Unauthorized" }, { status: 401 });

  try {
    const client = new Client({
      url: "http://localhost/graphql",
      schemaConfig: { interfaceToTypes: {} },
    });

    const error = await client
      .query(parse(`query Me { me { id } }`), {})
      .catch((error: unknown) => error);

    expect(error).toMatchObject({ reason: "status" });
    expect(await (error as ClientError).response?.json()).toEqual({
      message: "Unauthorized",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.each([
  {
    name: "a missing fragment",
    url: "http://localhost/graphql",
    source: `query Me { me { ...Missing } }`,
    variables: {},
  },
  {
    name: "a BigInt in the variables",
    url: "http://localhost/graphql",
    source: `query User($id: ID!) { user(id: $id) { id } }`,
    variables: { id: BigInt(1) },
  },
  {
    name: "an invalid URL",
    url: "http://[invalid",
    source: `query Me { me { id } }`,
    variables: {},
  },
])("$name is an 'unknown' error", async ({ url, source, variables }) => {
  const client = new Client({ url, schemaConfig: { interfaceToTypes: {} } });
  const result = client.query(parse(source), variables);

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "unknown" });
});
