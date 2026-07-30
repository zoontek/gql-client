import { type ASTNode, GraphQLError } from "@0no-co/graphql.web";

import type { JsonArray } from "../types";

/**
 * Why a `ClientError` was thrown:
 * - `"graphql"`: the response had a top-level `errors` array.
 * - `"httpStatus"`: the response status was not ok (outside 200-299).
 * - `"malformedResponse"`: the response body wasn't valid GraphQL JSON.
 * - `"network"`: the request failed before a response was received.
 * - `"timeout"`: the request exceeded the client's configured `timeout`.
 */
export type ClientErrorReason =
  | "graphql"
  | "httpStatus"
  | "malformedResponse"
  | "network"
  | "timeout";

const parseGraphQLError = (error: unknown): GraphQLError => {
  if (
    typeof error === "object" &&
    error != null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const originalError =
      "error" in error &&
      typeof error.error === "object" &&
      error.error != null &&
      "message" in error.error &&
      typeof error.error.message === "string"
        ? new Error(error.error.message)
        : null;

    // This reconstructs an error from an arbitrary network payload, so nothing
    // short of a full runtime schema check could verify these fields actually
    // hold the shapes below.
    const field = <T>(key: string): T | undefined =>
      key in error ? ((error as Record<string, unknown>)[key] as T) : undefined;

    return new GraphQLError(
      error.message,
      field<readonly ASTNode[] | ASTNode | null | undefined>("nodes"),
      "source" in error ? error.source : undefined,
      field<readonly number[] | null | undefined>("positions"),
      field<readonly (string | number)[] | null | undefined>("path"),
      originalError,
      field<{ [extension: string]: unknown } | null | undefined>("extensions"),
    );
  }

  return new GraphQLError(JSON.stringify(error));
};

/**
 * The error thrown by `Client#request`, `Client#query`, `useQuery`, and
 * `useMutation` for any failed request. Check `reason` to distinguish network
 * failures, timeouts, HTTP errors, and GraphQL errors; `graphQLErrors` holds
 * the parsed `errors` array for a `"graphql"` reason.
 */
export class ClientError extends Error {
  reason: ClientErrorReason;
  url: string;
  response: Response | undefined;
  graphQLErrors: GraphQLError[];

  constructor(
    message: string,
    options: {
      reason: ClientErrorReason;
      url: string;
      response?: Response | undefined;
      graphQLErrors?: GraphQLError[];
    },
  ) {
    super(message);
    Object.setPrototypeOf(this, ClientError.prototype);
    this.name = "ClientError";
    this.reason = options.reason;
    this.url = options.url;
    this.response = options.response;
    this.graphQLErrors = options.graphQLErrors ?? [];
  }

  // The `static` factories below build a `ClientError` for each `reason`.
  // They're used internally by `Client#request`; construct errors this way
  // rather than with `new ClientError(...)` directly.

  static network(url: string): ClientError {
    return new ClientError(`Request to ${url} failed`, {
      reason: "network",
      url,
    });
  }

  static timeout(url: string, timeout?: number): ClientError {
    return new ClientError(
      timeout == undefined
        ? `Request to ${url} timed out`
        : `Request to ${url} timed out (> ${timeout}ms)`,
      { reason: "timeout", url },
    );
  }

  static httpStatus(response: Response): ClientError {
    return new ClientError(
      `Request to ${response.url} gave status ${response.status}`,
      { reason: "httpStatus", url: response.url, response },
    );
  }

  static malformedResponse(url: string, response: Response): ClientError {
    return new ClientError("Received a malformed GraphQL response", {
      reason: "malformedResponse",
      url,
      response,
    });
  }

  static graphql(
    url: string,
    response: Response,
    errors: JsonArray,
  ): ClientError {
    const graphQLErrors = errors.map(parseGraphQLError);

    return new ClientError(
      graphQLErrors[0]?.message ?? "Received a GraphQL error",
      { reason: "graphql", url, response, graphQLErrors },
    );
  }
}
