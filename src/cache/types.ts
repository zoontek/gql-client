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

// Sentinel used internally to signal a cache miss. It is distinct from a cached
// `null`/`undefined` value, which are legitimate results that must be preserved.
export const MISS = Symbol("MISS");

export type SchemaConfig = {
  interfaceToTypes: Record<string, string[]>;
};

export type ConnectionInfo = {
  // The connection's own entry, so updateConnection can edit its edges directly.
  cacheEntry: CacheEntry;
  // The full operation that produced this connection, so it can be re-read
  // from cache after an update (variables and pathInQuery locate the
  // connection within that operation's result).
  document: TypedDocumentNode;
  variables: AnyVariables;
  pathInQuery: PropertyKey[];
  fieldVariables: AnyVariables;
};

export type CacheEntry = Record<PropertyKey, unknown> & {
  [REQUESTED_KEYS]: Set<symbol>;
  [CONNECTION_REF]?: number;
};

export const createEmptyCacheEntry = (): CacheEntry => ({
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

export type CachedEdge = {
  [TYPENAME_KEY]: string | null | undefined;
  [NODE_KEY]: symbol;
  [CURSOR_KEY]?: string | null | undefined;
};

export const isCachedEdge = (value: unknown): value is CachedEdge =>
  isRecord(value) && typeof value[NODE_KEY] === "symbol";
