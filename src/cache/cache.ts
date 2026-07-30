import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { AnyVariables, Connection, Edge, JsonValue } from "../types";
import { filterMap } from "../utils";
import {
  CONNECTION_REF,
  CURSOR_KEY,
  EDGES_KEY,
  NODE_KEY,
  TYPENAME_KEY,
  getCacheEntryKey,
} from "./keys";
import { createReadOperation } from "./read";
import {
  MISS,
  createEmptyCacheEntry,
  isCacheEntry,
  isCachedEdge,
  type CacheEntry,
  type CachedEdge,
  type ConnectionInfo,
  type SchemaConfig,
} from "./types";
import { trackField } from "./watch";
import { createWriteOperation } from "./write";

export type { ConnectionInfo, SchemaConfig } from "./types";

export class ClientCache {
  private cache = new Map<symbol, CacheEntry>();
  private interfaceToType: Record<string, Set<string>>;
  private connectionCache: Map<number, ConnectionInfo>;
  private connectionRefCount = -1;

  public readonly readOperation: (
    document: TypedDocumentNode,
    variables: AnyVariables,
    watched?: Map<object, Set<symbol>>,
  ) => JsonValue | undefined;

  public readonly writeOperation: (
    document: TypedDocumentNode,
    response: JsonValue,
    variables: AnyVariables,
    touched?: Map<object, Set<symbol>>,
  ) => void;

  public constructor(schemaConfig: SchemaConfig) {
    this.interfaceToType = Object.fromEntries(
      Object.entries(schemaConfig.interfaceToTypes).map(([key, value]) => [
        key,
        new Set<string>(value),
      ]),
    );
    this.connectionCache = new Map<number, ConnectionInfo>();

    this.readOperation = createReadOperation({
      get: (cacheKey) => this.get(cacheKey),
      isTypeCompatible: (typename, typeCondition) =>
        this.isTypeCompatible(typename, typeCondition),
    });

    this.writeOperation = createWriteOperation({
      getOrCreateEntry: (cacheKey) => this.getOrCreateEntry(cacheKey),
      linkCacheEntry: (json, existing) => this.linkCacheEntry(json, existing),
      registerConnectionInfo: (info) => this.registerConnectionInfo(info),
    });
  }

  public dump(): Map<symbol, CacheEntry> {
    return this.cache;
  }

  public getCachedConnection(id: number): ConnectionInfo | undefined {
    return this.connectionCache.get(id);
  }

  public registerConnectionInfo(info: ConnectionInfo): number {
    const id = ++this.connectionRefCount;
    this.connectionCache.set(id, info);
    return id;
  }

  private isTypeCompatible(typename: string, typeCondition: string): boolean {
    if (typename === typeCondition) {
      return true;
    }
    const compatibleTypes = this.interfaceToType[typeCondition];
    if (compatibleTypes == undefined) {
      return false;
    }
    return compatibleTypes.has(typename);
  }

  // Raw map lookup, defaulting to the MISS sentinel. Shared by the read path
  // (via `readOperation`'s injected `get`) and `mapEdgesToCacheEntries` below.
  private get(cacheKey: symbol): CacheEntry | typeof MISS {
    const entry = this.cache.get(cacheKey);
    return entry === undefined ? MISS : entry;
  }

  private getOrCreateEntry(cacheKey: symbol): CacheEntry {
    const cached = this.cache.get(cacheKey);

    if (cached != null) {
      return cached;
    }

    const entry = createEmptyCacheEntry();
    this.cache.set(cacheKey, entry);
    return entry;
  }

  // Resolve the cache entry for a nested object (creating it if needed) and the
  // value to store in the parent: a shared symbol key for identifiable entities
  // (so they are deduplicated and updated in one place), otherwise the inline
  // entry. `existing` is the parent's current slot, reused for keyless entries.
  private linkCacheEntry(
    json: unknown,
    existing: unknown,
  ): { entry: CacheEntry; stored: symbol | CacheEntry } {
    const cacheKey = getCacheEntryKey(json);
    const entry =
      cacheKey !== undefined
        ? this.getOrCreateEntry(cacheKey)
        : isCacheEntry(existing)
          ? existing
          : createEmptyCacheEntry();
    return { entry, stored: cacheKey ?? entry };
  }

  private mapEdgesToCacheEntries<A>(edges: Edge<A>[]): CachedEdge[] {
    return filterMap(edges, ({ node, __typename, cursor }) => {
      const key = getCacheEntryKey(node);
      // we can omit the requested fields here because the Connection<A> contrains the fields
      if (key === undefined || this.get(key) === MISS) {
        return undefined;
      }
      // Preserve `cursor` alongside the node reference. Without it, a query that
      // selects `edges { cursor ... }` reads the synthesized edge as a miss and
      // the whole connection read fails.
      return {
        [TYPENAME_KEY]: __typename,
        [NODE_KEY]: key,
        [CURSOR_KEY]: cursor,
      };
    });
  }

  public updateConnection<A>(
    connection: Connection<A>,
    config:
      | { prepend: Edge<A>[] }
      | { append: Edge<A>[] }
      | { remove: string[] },
    touched?: Map<object, Set<symbol>>,
  ): void {
    if (connection == null) {
      return;
    }
    if (
      CONNECTION_REF in connection &&
      typeof connection[CONNECTION_REF] === "number"
    ) {
      const connectionConfig = this.getCachedConnection(
        connection[CONNECTION_REF],
      );
      if (connectionConfig == null) {
        return;
      }

      // `edges` may not be cached at all (e.g. the connection was queried with
      // only `pageInfo`, or its edges haven't resolved yet), so default to an
      // empty list rather than spreading/filtering `undefined`.
      const cachedEdges = connectionConfig.cacheEntry[EDGES_KEY];
      const currentEdges =
        Array.isArray(cachedEdges) && cachedEdges.every(isCachedEdge)
          ? cachedEdges
          : [];

      if (touched !== undefined) {
        trackField(touched, connectionConfig.cacheEntry, EDGES_KEY);
      }

      if ("prepend" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...this.mapEdgesToCacheEntries(config.prepend),
          ...currentEdges,
        ];
        return;
      }

      if ("append" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...currentEdges,
          ...this.mapEdgesToCacheEntries(config.append),
        ];
        return;
      }

      const nodeIds = new Set(config.remove);
      connectionConfig.cacheEntry[EDGES_KEY] = currentEdges.filter((edge) => {
        const description = edge[NODE_KEY].description;

        if (description === undefined) {
          return true;
        }

        // Cache keys are `${typename}<${id}>`. A GraphQL type name never
        // contains `<`, so the first `<` and the trailing `>` bound the id
        // exactly — even when the id itself contains angle brackets. Anchoring
        // on those (rather than a greedy regex) also avoids `"1"` matching the
        // `"11"` segment of another key.
        const start = description.indexOf("<");
        const id = start === -1 ? undefined : description.slice(start + 1, -1);
        return id === undefined || !nodeIds.has(id);
      });
    }
  }
}
