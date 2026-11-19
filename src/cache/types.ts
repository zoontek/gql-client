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
  // The operation that wrote the connection, and the path to the connection in
  // its result. usePagination reads each page with them.
  document: TypedDocumentNode;
  variables: AnyVariables;
  path: PropertyKey[];
  // Arguments of the connection field. usePagination looks for `after` or
  // `before` in them.
  fieldArguments: AnyVariables;
  // Each query field that wrote this connection, with its last variables.
  // updateConnection checks new edges against their selections.
  readers: Map<
    FieldNode,
    { document: TypedDocumentNode; variables: AnyVariables }
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

export const isCacheEntryArrayItem = (
  value: unknown,
): value is symbol | CacheEntry | null =>
  value === null || typeof value === "symbol" || isCacheEntry(value);

type CachedEdge = {
  [TYPENAME_KEY]: string | null | undefined;
  [NODE_KEY]: symbol;
  [CURSOR_KEY]?: string | null | undefined;
};

export const isCachedEdge = (value: unknown): value is CachedEdge =>
  isRecord(value) && typeof value[NODE_KEY] === "symbol";
