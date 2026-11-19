import { afterEach, expect, test } from "bun:test";

import { parse } from "@0no-co/graphql.web";

import { ClientError } from "../../src/client/errors";
import { createClient } from "../shared";
import { jsonResponse, mockFetch, restoreFetch } from "./helpers";

afterEach(restoreFetch);

const MeQuery = parse(`query Me { me { id } }`);
const PingMutation = parse(`mutation M { ping }`);

const getError = async (promise: Promise<unknown>): Promise<ClientError> => {
  const error = await promise.then(
    () => {
      throw new Error("Expected the promise to reject");
    },
    (error: unknown) => error,
  );

  expect(error).toBeInstanceOf(ClientError);
  return error as ClientError;
};

// Some `fetch` implementations reject with a plain `AbortError` instead of
// the signal's reason, before and during the body read.
const abortError = (): DOMException =>
  new DOMException("The operation was aborted.", "AbortError");

// Rejects like `fetch` when its signal aborts, and never resolves otherwise.
const pendingFetch = (_request: Request, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted === true) {
      reject(abortError());
      return;
    }

    init.signal?.addEventListener("abort", () => {
      reject(abortError());
    });
  });

// Sends the response headers, then errors the body stream on abort.
const bodyFailingOnAbort =
  (status: number) => async (_request: Request, init: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            controller.error(abortError());
          });
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );

test("a transformRequest that throws is an 'unknown' error caused by the thrown error", async () => {
  const transformError = new Error("boom");

  const client = createClient({
    transformRequest: () => {
      throw transformError;
    },
  });

  expect(await getError(client.query(MeQuery, {}))).toMatchObject({
    reason: "unknown",
    cause: transformError,
  });
});

test("a transformRequest that rejects is an 'unknown' error", async () => {
  const client = createClient({
    transformRequest: async () => {
      throw new Error("boom");
    },
  });

  expect(await getError(client.mutate(PingMutation, {}))).toMatchObject({
    reason: "unknown",
  });
});

test("a consumed request from transformRequest is an 'unknown' error", async () => {
  const client = createClient({
    transformRequest: async (request) => {
      await request.text();
      return request;
    },
  });

  const error = await getError(client.mutate(PingMutation, {}));

  expect(error).toMatchObject({ reason: "unknown" });
  expect(error.cause).toBeInstanceOf(TypeError);
  expect(String(error.cause)).toContain("request.clone()");
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
  const client = createClient({ url });

  expect(await getError(client.query(parse(source), variables))).toMatchObject({
    reason: "unknown",
  });
});

test("an error in connectionUpdates is an 'unknown' error, and the write is still announced", async () => {
  mockFetch(() =>
    jsonResponse({
      data: {
        __typename: "Mutation",
        addItem: { __typename: "Item", id: "1" },
      },
    }),
  );

  const client = createClient();
  const callbackError = new TypeError("Cannot read properties of undefined");

  let notified = 0;
  client.subscribe(() => {
    notified++;
  });

  const error = await getError(
    client.mutate(
      parse(`mutation AddItem { addItem { id } }`),
      {},
      {
        connectionUpdates: [
          () => {
            throw callbackError;
          },
        ],
      },
    ),
  );

  expect(error).toMatchObject({ reason: "unknown", cause: callbackError });
  expect(client.cache.dump().has(Symbol.for("Item<1>"))).toBe(true);
  expect(notified).toBe(1);
});

test("a fetch failure is a 'network' error caused by the fetch error", async () => {
  const fetchError = new TypeError("Failed to fetch");

  mockFetch(async () => {
    throw fetchError;
  });

  expect(await getError(createClient().query(MeQuery, {}))).toMatchObject({
    reason: "network",
    cause: fetchError,
  });
});

test("a connection drop during the body read is a 'network' error", async () => {
  const dropError = new TypeError("terminated");

  mockFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            controller.error(dropError);
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );

  expect(await getError(createClient().query(MeQuery, {}))).toMatchObject({
    reason: "network",
    cause: dropError,
  });
});

test("a body that isn't JSON is a 'malformed' error caused by the parse error", async () => {
  mockFetch(
    async () =>
      new Response("<html>Bad Gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
  );

  const error = await getError(createClient().query(MeQuery, {}));

  expect(error).toMatchObject({ reason: "malformed" });
  expect(error.cause).toBeInstanceOf(SyntaxError);
});

test("a timeout before the response is a 'timeout' error caused by the abort error", async () => {
  mockFetch(pendingFetch);

  const error = await getError(
    createClient({ timeout: 10 }).query(MeQuery, {}),
  );

  expect(error).toMatchObject({ reason: "timeout" });
  expect(error.cause).toBeInstanceOf(DOMException);
});

test("a timeout during the body read is a 'timeout' error, not 'malformed'", async () => {
  mockFetch(bodyFailingOnAbort(200));

  expect(
    await getError(createClient({ timeout: 10 }).query(MeQuery, {})),
  ).toMatchObject({ reason: "timeout" });
});

test("an error body that never ends is a 'status' error once the timeout fires", async () => {
  mockFetch(bodyFailingOnAbort(500));

  expect(
    await getError(createClient({ timeout: 10 }).query(MeQuery, {})),
  ).toMatchObject({ reason: "status" });
});

test("aborting the signal set by transformRequest is an 'aborted' error", async () => {
  mockFetch(pendingFetch);
  const controller = new AbortController();

  const client = createClient({
    transformRequest: (request) =>
      new Request(request, { signal: controller.signal }),
  });

  const result = getError(client.query(MeQuery, {}));
  setTimeout(() => {
    controller.abort();
  }, 5);

  expect(await result).toMatchObject({ reason: "aborted" });
});

test("a signal already aborted by transformRequest is an 'aborted' error", async () => {
  mockFetch(pendingFetch);

  const client = createClient({
    transformRequest: (request) =>
      new Request(request, { signal: AbortSignal.abort() }),
  });

  expect(await getError(client.query(MeQuery, {}))).toMatchObject({
    reason: "aborted",
  });
});

test("an empty `errors` array next to `data` is not an error", async () => {
  mockFetch(() =>
    jsonResponse({
      data: { __typename: "Query", me: { __typename: "User", id: "1" } },
      errors: [],
    }),
  );

  await expect(createClient().query(MeQuery, {})).resolves.toMatchObject({
    me: { id: "1" },
  });
});

test("a response with `data` and errors is a 'graphQL' error and is not written to the cache", async () => {
  mockFetch(() =>
    jsonResponse({
      data: {
        __typename: "Query",
        me: { __typename: "User", id: "1", avatar: null },
      },
      errors: [{ message: "Avatar service is down", path: ["me", "avatar"] }],
    }),
  );

  const client = createClient();
  const error = await getError(
    client.query(parse(`query Me { me { id avatar } }`), {}),
  );

  expect(error).toMatchObject({
    reason: "graphQL",
    message: "Avatar service is down",
  });
  expect(client.cache.dump().size).toBe(0);
});

test("GraphQL errors with a 4xx status are a 'graphQL' error", async () => {
  mockFetch(() =>
    jsonResponse(
      { errors: [{ message: 'Cannot query field "nope" on type "Query".' }] },
      { status: 400 },
    ),
  );

  const error = await getError(
    createClient().query(parse(`query Q { nope }`), {}),
  );

  expect(error).toMatchObject({ reason: "graphQL" });
  expect(error.response?.status).toBe(400);
  expect(error.graphQLErrors[0]?.message).toContain("nope");
});

test("a 4xx JSON body without GraphQL errors is a 'status' error with a readable response", async () => {
  mockFetch(() => jsonResponse({ message: "Unauthorized" }, { status: 401 }));

  const error = await getError(createClient().query(MeQuery, {}));

  expect(error).toMatchObject({ reason: "status" });
  expect(await error.response?.json()).toEqual({ message: "Unauthorized" });
});
