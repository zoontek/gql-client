import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { AnyVariables } from "../types";
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

export type Schema = {
  interfaceToTypes: Record<string, string[]>;
};

export type ConnectionInfo = {
  // useful for connection updates
  cacheEntry: CacheEntry;
  // to re-read from cache
  document: TypedDocumentNode;
  variables: AnyVariables;
  pathInQuery: PropertyKey[];
  fieldVariables: AnyVariables;
};

export type CacheEntry = Record<symbol, unknown> & {
  [REQUESTED_KEYS]: Set<symbol>;
  [CONNECTION_REF]?: number;
};

export const createEmptyCacheEntry = (): CacheEntry => ({
  [REQUESTED_KEYS]: new Set<symbol>(),
});

export type CachedEdge = {
  [TYPENAME_KEY]: string | null | undefined;
  [NODE_KEY]: symbol;
  [CURSOR_KEY]?: string | null | undefined;
};
