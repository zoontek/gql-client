import { parse } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import { ClientCache } from "../../src/cache/cache";
import type { SchemaConfig } from "../../src/cache/types";
import { transformDocument } from "../../src/graphql/transform";
import type { AnyVariables, JsonValue } from "../../src/types";

// Build a transformed document directly from a query string, decoupled from
// the gql.tada schema so we can freely exercise read-path branches.
export const doc = (source: string): TypedDocumentNode =>
  transformDocument(parse(source));

export const setup = (
  source: string,
  response: JsonValue,
  variables: AnyVariables = {},
  schemaConfig: SchemaConfig = { interfaceToTypes: {} },
) => {
  const cache = new ClientCache(schemaConfig);
  const document = doc(source);
  cache.writeOperation(document, response, variables);

  return {
    cache,
    document,
    read: () => cache.readOperation(document, variables),
  };
};

// Runs `run` with `NODE_ENV` set to "development", for dev-only warnings.
export const inDevelopment = (run: () => void): void => {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    run();
  } finally {
    if (nodeEnv == null) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
  }
};

export const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

type FetchMock = (
  request: Request,
  init: RequestInit,
) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;

// Call `restoreFetch` in an `afterEach` of every file that uses `mockFetch`.
export const mockFetch = (fetchMock: FetchMock): void => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
};

export const restoreFetch = (): void => {
  globalThis.fetch = originalFetch;
};
