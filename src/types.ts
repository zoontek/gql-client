// From type-fest
export type JsonObject = { [Key in string]: JsonValue };
export type JsonArray = JsonValue[] | readonly JsonValue[];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

// Copied from TypeScript DOM types for React Native compatibility
export type RequestCredentials = "include" | "omit" | "same-origin";

/** Variables shape accepted by `useQuery`, `useMutation`, and `Client#mutate`. */
export type AnyVariables = Record<string, unknown>;

/** A Relay-style connection edge, wrapping a `node` of type `T`. */
export type Edge<T> = {
  __typename?: string | null | undefined;
  cursor?: string | null | undefined;
  node?: T | null | undefined;
};

/**
 * A Relay-style connection of `Edge<T>`s with cursor-based `pageInfo`, as
 * used by `useForwardPagination` and `useBackwardPagination`.
 */
export type Connection<T> =
  | {
      edges?: (Edge<T> | null | undefined)[] | null | undefined;
      pageInfo: {
        hasPreviousPage?: boolean | null | undefined;
        hasNextPage?: boolean | null | undefined;
        endCursor?: string | null | undefined;
        startCursor?: string | null | undefined;
      };
    }
  | null
  | undefined;
