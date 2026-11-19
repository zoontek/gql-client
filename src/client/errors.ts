import { GraphQLError, type ASTNode } from "@0no-co/graphql.web";

import type { JsonArray } from "../types";
import { isRecord } from "../utils";

/**
 * Why a request failed:
 *
 * - `aborted`: the request `signal` was aborted.
 * - `graphQL`: the response has a top-level `errors` array.
 * - `malformed`: the response body is not valid GraphQL JSON.
 * - `network`: the connection failed, before or during the response.
 * - `status`: the response status is outside the 200-299 range.
 * - `timeout`: the request took longer than the client `timeout`.
 * - `unknown`: something else threw, see `cause`.
 */
export type ClientErrorReason =
  | "aborted"
  | "graphQL"
  | "malformed"
  | "network"
  | "status"
  | "timeout"
  | "unknown";

const parseGraphQLError = (error: unknown): GraphQLError => {
  if (!isRecord(error) || typeof error.message !== "string") {
    return new GraphQLError(JSON.stringify(error));
  }

  const { message, nodes, source, positions, path, extensions } = error;
  const originalError = error.error;

  return new GraphQLError(
    message,
    nodes as readonly ASTNode[] | ASTNode | null | undefined,
    source,
    positions as readonly number[] | null | undefined,
    path as readonly (string | number)[] | null | undefined,
    isRecord(originalError) && typeof originalError.message === "string"
      ? new Error(originalError.message)
      : null,
    extensions as { [extension: string]: unknown } | null | undefined,
  );
};

/**
 * The error of every failed request made by the client.
 *
 * @see https://zoontek.github.io/gql-client/errors
 */
export class ClientError extends Error {
  /** Why the request failed. */
  reason: ClientErrorReason;
  /** The request URL. */
  url: string;
  /** The `fetch` response, when the client received one. */
  response: Response | undefined;
  /** The parsed `errors` array. Empty unless `reason` is `"graphQL"`. */
  graphQLErrors: GraphQLError[];

  constructor(
    message: string,
    options: {
      reason: ClientErrorReason;
      url: string;
      response?: Response | undefined;
      graphQLErrors?: GraphQLError[];
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ClientError";
    this.reason = options.reason;
    this.url = options.url;
    this.response = options.response;
    this.graphQLErrors = options.graphQLErrors ?? [];
    this.cause = options.cause;
  }

  /** Creates an error with the `"aborted"` reason. */
  static aborted(url: string, cause?: unknown): ClientError {
    return new ClientError(`Request to ${url} was aborted`, {
      reason: "aborted",
      url,
      cause,
    });
  }

  /** Creates an error with the `"network"` reason. */
  static network(url: string, cause?: unknown): ClientError {
    return new ClientError(`Request to ${url} failed`, {
      reason: "network",
      url,
      cause,
    });
  }

  /** Creates an error with the `"timeout"` reason. */
  static timeout(url: string, timeout?: number, cause?: unknown): ClientError {
    return new ClientError(
      timeout == null
        ? `Request to ${url} timed out`
        : `Request to ${url} timed out (> ${timeout}ms)`,
      { reason: "timeout", url, cause },
    );
  }

  /** Creates an error with the `"status"` reason. */
  static status(response: Response): ClientError {
    return new ClientError(
      `Request to ${response.url} gave status ${response.status}`,
      { reason: "status", url: response.url, response },
    );
  }

  /** Creates an error with the `"malformed"` reason. */
  static malformed(
    url: string,
    response: Response,
    cause?: unknown,
  ): ClientError {
    return new ClientError("Received a malformed GraphQL response", {
      reason: "malformed",
      url,
      response,
      cause,
    });
  }

  /**
   * Creates an error with the `"graphQL"` reason. Its message is the message
   * of the first GraphQL error.
   */
  static graphQL(
    url: string,
    response: Response,
    errors: JsonArray,
  ): ClientError {
    const graphQLErrors = errors.map(parseGraphQLError);

    return new ClientError(
      graphQLErrors[0]?.message ?? "Received a GraphQL error",
      { reason: "graphQL", url, response, graphQLErrors },
    );
  }

  /** Creates an error with the `"unknown"` reason. */
  static unknown(url: string, cause: unknown): ClientError {
    return new ClientError(`Request to ${url} failed with an unknown error`, {
      reason: "unknown",
      url,
      cause,
    });
  }
}
