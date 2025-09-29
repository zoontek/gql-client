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
