// From type-fest
export type JsonObject = { [Key in string]: JsonValue };
export type JsonArray = JsonValue[]; // | readonly JsonValue[];
export type JsonPrimitive = string | number | boolean | null | undefined; // undefined is not standard
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type AnyVariables = Record<string, unknown>;

export type Edge<T> = {
  __typename?: string | null | undefined;
  cursor?: string | null | undefined;
  node?: T | null | undefined;
};

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
