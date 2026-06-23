import { type ASTNode, GraphQLError } from "@0no-co/graphql.web";
import {
  BadStatusError,
  EmptyResponseError,
  NetworkError,
  TimeoutError,
} from "@bloodyowl/request";
import type { JsonValue } from "./types";

export type ClientError =
  | NetworkError
  | TimeoutError
  | BadStatusError
  | EmptyResponseError
  | InvalidGraphQLResponseError
  | CacheError
  | GraphQLError[];

export class InvalidGraphQLResponseError extends Error {
  response: unknown;
  constructor(response: unknown) {
    super("Received an invalid GraphQL response");
    Object.setPrototypeOf(this, InvalidGraphQLResponseError.prototype);
    this.name = "InvalidGraphQLResponseError";
    this.response = response;
  }
}

export class CacheError extends Error {
  constructor(operationName: string | undefined) {
    super(
      operationName != null
        ? `Unable to read operation "${operationName}" from cache`
        : "Unable to read operation from cache",
    );

    Object.setPrototypeOf(this, CacheError.prototype);
    this.name = "CacheError";
  }
}

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
