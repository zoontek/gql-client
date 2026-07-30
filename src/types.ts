// From type-fest
export type JsonObject = { [Key in string]: JsonValue };
export type JsonArray = JsonValue[] | readonly JsonValue[];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** Variables shape accepted by `useQuery`, `useMutation`, and `Client#request`. */
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
