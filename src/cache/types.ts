import type { FieldNode } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import type { AnyVariables } from "../types";
import { isRecord } from "../utils";
import {
  CONNECTION_REF,
  CURSOR_KEY,
  NODE_KEY,
  REQUESTED_KEYS,
  TYPENAME_KEY,
} from "./keys";

export type SchemaConfig = {
  interfaceToTypes: Record<string, string[]>;
};

export type ConnectionInfo = {
  entry: CacheEntry;
  // Arguments of the connection field. usePagination looks for `after` or
  // `before` in them.
  fieldArguments: AnyVariables;
  // Each query field that wrote this connection, with its last variables and
  // the path to the connection in its result. updateConnection checks new edges
  // against their selections. usePagination reads each page through them.
  readers: Map<
    FieldNode,
    {
      document: TypedDocumentNode;
      path: PropertyKey[];
      variables: AnyVariables;
    }
  >;
};

export type ConnectionRef = object;

export type CacheEntry = Record<PropertyKey, unknown> & {
  [REQUESTED_KEYS]: Set<symbol>;
  [CONNECTION_REF]?: ConnectionRef;
};

export const createCacheEntry = (): CacheEntry => ({
  [REQUESTED_KEYS]: new Set<symbol>(),
});

export const isCacheEntry = (value: unknown): value is CacheEntry =>
  isRecord(value) &&
  REQUESTED_KEYS in value &&
  value[REQUESTED_KEYS] instanceof Set;

type CachedEdge = {
  [TYPENAME_KEY]: string | null | undefined;
  [NODE_KEY]: symbol;
  [CURSOR_KEY]?: string | null | undefined;
};

export const isCachedEdge = (value: unknown): value is CachedEdge =>
  isRecord(value) && typeof value[NODE_KEY] === "symbol";
