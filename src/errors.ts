import { type ASTNode, GraphQLError } from "@0no-co/graphql.web";
import type { JsonValue } from "./types";

export class NetworkError extends Error {
  url: string;
  constructor(url: string) {
    super(`Request to ${url} failed`);
    Object.setPrototypeOf(this, NetworkError.prototype);
    this.name = "NetworkError";
    this.url = url;
  }
}

export class TimeoutError extends Error {
  url: string;
  timeout: number | undefined;
  constructor(url: string, timeout?: number) {
    if (timeout == undefined) {
      super(`Request to ${url} timed out`);
    } else {
      super(`Request to ${url} timed out (> ${timeout}ms)`);
    }
    Object.setPrototypeOf(this, TimeoutError.prototype);
    this.name = "TimeoutError";
    this.url = url;
    this.timeout = timeout;
  }
}

export class BadStatusError extends Error {
  response: Response;

  constructor(response: Response) {
    super(`Request to ${response.url} gave status ${response.status}`);
    Object.setPrototypeOf(this, BadStatusError.prototype);
    this.name = "BadStatusError";
    this.response = response;
  }
}

export class InvalidResponseError extends Error {
  response: unknown;
  constructor(response: unknown) {
    super("Received an invalid GraphQL response");
    Object.setPrototypeOf(this, InvalidResponseError.prototype);
    this.name = "InvalidResponseError";
    this.response = response;
  }
}

export type ClientError =
  | NetworkError
  | TimeoutError
  | BadStatusError
  | InvalidResponseError
  | GraphQLError[];

export const parseGraphQLError = (error: unknown): GraphQLError => {
  if (
    typeof error === "object" &&
    error != null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const graphqlError = error as Record<PropertyKey, JsonValue> & {
      message: string;
    };
    const originalError =
      "error" in error &&
      typeof error.error === "object" &&
      error.error != null &&
      "message" in error.error &&
      typeof error.error.message === "string"
        ? new Error(error.error.message)
        : null;
    return new GraphQLError(
      graphqlError.message,
      graphqlError.nodes as readonly ASTNode[] | ASTNode | null | undefined,
      graphqlError.source,
      graphqlError.positions as readonly number[] | null | undefined,
      graphqlError.path as readonly (string | number)[] | null | undefined,
      originalError,
      graphqlError.extensions as
        | {
            [extension: string]: unknown;
          }
        | null
        | undefined,
    );
  }
  return new GraphQLError(JSON.stringify(error));
};
