import { type ASTNode, GraphQLError } from "@0no-co/graphql.web";
import type { JsonArray, JsonValue } from "./types";

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
    const graphQLError = error as Record<PropertyKey, JsonValue> & {
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
      graphQLError.message,
      graphQLError.nodes as readonly ASTNode[] | ASTNode | null | undefined,
      graphQLError.source,
      graphQLError.positions as readonly number[] | null | undefined,
      graphQLError.path as readonly (string | number)[] | null | undefined,
      originalError,
      graphQLError.extensions as
        | { [extension: string]: unknown }
        | null
        | undefined,
    );
  }
  return new GraphQLError(JSON.stringify(error));
};

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
