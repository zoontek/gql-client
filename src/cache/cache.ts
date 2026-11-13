import { Kind, type SelectionSetNode } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import { getFieldNameWithArguments, isExcluded } from "../graphql/ast";
import type { AnyVariables, Connection, Edge, JsonValue } from "../types";
import { filterMap } from "../utils";
import {
  CONNECTION_REF,
  CURSOR_KEY,
  EDGES_KEY,
  NODE_KEY,
  REQUESTED_KEYS,
  TYPENAME_KEY,
  getCacheEntryKey,
  getIdFromCacheKey,
} from "./keys";
import {
  createReadOperation,
  type CanReadSelection,
  type ReadOperation,
  type ResultCache,
} from "./read";
import { decodeEntry, encodeEntry, type SerializedCache } from "./serialize";
import {
  MISS,
  createEmptyCacheEntry,
  isCacheEntry,
  isCachedEdge,
  type CacheEntry,
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
  // Never reset, so a ref held by a mounted hook can't match a connection
  // registered after `purge` or `restore`.
  private connectionRefCount = -1;
  private resultCache: ResultCache = new WeakMap();

  public readonly readOperation: ReadOperation;
  private readonly canReadSelection: CanReadSelection;

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

    const { readOperation, canReadSelection } = createReadOperation({
      get: (cacheKey) => this.get(cacheKey),
      getResultCache: () => this.resultCache,
      isTypeCompatible: (typename, typeCondition) =>
        this.isTypeCompatible(typename, typeCondition),
    });

    this.readOperation = readOperation;
    this.canReadSelection = canReadSelection;

    this.writeOperation = createWriteOperation({
      getOrCreateEntry: (cacheKey) => this.getOrCreateEntry(cacheKey),
      isTypeCompatible: (typename, typeCondition) =>
        this.isTypeCompatible(typename, typeCondition),
      linkCacheEntry: (json, existing) => this.linkCacheEntry(json, existing),
      registerConnectionInfo: (info) => this.registerConnectionInfo(info),
    });
  }

  // Drops every entry, registered connection, and stored read result.
  // Exposed through `Client#purge`; see the rationale there.
  public purge(): void {
    this.cache = new Map();
    this.connectionCache = new Map();
    this.resultCache = new WeakMap();
  }

  // Serializes every entry to a JSON-safe structure. Exposed through
  // `Client#extract`; see the SSR flow there.
  public extract(): SerializedCache {
    return {
      entries: [...this.cache].map(([key, entry]) => [
        key.description ?? "",
        encodeEntry(entry),
      ]),
    };
  }

  // Replaces the cache content with a previously extracted structure.
  // Connection registrations are not restored: they hold live references
  // (documents, entries) and are rebuilt when a response is written.
  public restore(data: SerializedCache): void {
    this.cache = new Map(
      data.entries.map(([key, entry]) => [Symbol.for(key), decodeEntry(entry)]),
    );
    this.connectionCache = new Map();
    this.resultCache = new WeakMap();
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
    if (compatibleTypes == null) {
      return false;
    }
    return compatibleTypes.has(typename);
  }

  // Raw map lookup, defaulting to the MISS sentinel. Shared by the read path
  // (via `readOperation`'s injected `get`) and `mapEdgesToCacheEntries`.
  private get(cacheKey: symbol): CacheEntry | typeof MISS {
    const entry = this.cache.get(cacheKey);
    return entry == null ? MISS : entry;
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

  // Resolves the cache entry for a nested object (creating it if needed), and
  // the value to store in the parent: a shared symbol key for identifiable
  // entities (so they get deduplicated and updated in one place), or the
  // inline entry otherwise. `existing` is the parent's current slot, reused
  // for keyless entries.
  private linkCacheEntry(
    json: unknown,
    existing: unknown,
  ): { entry: CacheEntry; stored: symbol | CacheEntry } {
    const cacheKey = getCacheEntryKey(json);
    const entry =
      cacheKey != null
        ? this.getOrCreateEntry(cacheKey)
        : isCacheEntry(existing)
          ? existing
          : createEmptyCacheEntry();
    return { entry, stored: cacheKey ?? entry };
  }

  // The selection sets of the `edges` fields under the connection field,
  // including inline fragments that apply to the connection's type.
  private getEdgesSelectionSets(info: ConnectionInfo): SelectionSetNode[] {
    const { cacheEntry, field, variables } = info;
    const typename = cacheEntry[TYPENAME_KEY];
    const selectionSets: SelectionSetNode[] = [];

    const collect = (selectionSet: SelectionSetNode): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (
            selection.selectionSet != null &&
            !isExcluded(selection, variables) &&
            getFieldNameWithArguments(selection, variables) === EDGES_KEY
          ) {
            selectionSets.push(selection.selectionSet);
          }
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          const typeCondition = selection.typeCondition?.name.value;

          if (
            !isExcluded(selection, variables) &&
            (typeCondition == null ||
              typeof typename !== "string" ||
              this.isTypeCompatible(typename, typeCondition))
          ) {
            collect(selection.selectionSet);
          }
        }
      }
    };

    if (field.selectionSet != null) {
      collect(field.selectionSet);
    }

    return selectionSets;
  }

  private mapEdgesToCacheEntries<A>(
    edges: (Edge<A> | null | undefined)[],
    info: ConnectionInfo,
  ): CacheEntry[] {
    const edgesSelectionSets = this.getEdgesSelectionSets(info);

    return filterMap(edges, (item) => {
      // A `null` edge adds nothing.
      if (item == null) {
        return undefined;
      }

      const { node, __typename, cursor } = item;
      const key = getCacheEntryKey(node);

      if (key == null || this.get(key) === MISS) {
        return undefined;
      }

      // A real cache entry, so later writes to this connection reuse the
      // edges array and `extract` serializes it. `cursor` is kept alongside
      // the node reference: without it, a query that selects
      // `edges { cursor ... }` reads the synthesized edge as a miss and the
      // whole connection read fails.
      const edge = createEmptyCacheEntry();
      edge[REQUESTED_KEYS].add(NODE_KEY).add(CURSOR_KEY);

      if (typeof __typename === "string") {
        edge[TYPENAME_KEY] = __typename;
      }

      edge[NODE_KEY] = key;
      edge[CURSOR_KEY] = cursor ?? null;

      // An edge the connection's query can't fully read would turn the whole
      // query into a cache miss. This happens when the request that returned
      // the node selected fewer fields than the connection's query.
      const readable = edgesSelectionSets.every((selectionSet) =>
        this.canReadSelection(selectionSet, edge, info.variables),
      );

      if (!readable) {
        if (process.env.NODE_ENV === "development") {
          console.warn(
            `GraphQL Client: skipped adding ${key.description ?? "a node"} to a connection. ` +
              "The cache doesn't have every field the connection's query selects on its edges. " +
              "Select the same fields in the request that returns the node.",
          );
        }
        return undefined;
      }

      return edge;
    });
  }

  public updateConnection<A>(
    connection: Connection<A>,
    config:
      | { prepend: (Edge<A> | null | undefined)[] }
      | { append: (Edge<A> | null | undefined)[] }
      | { remove: (string | number)[] },
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
      // empty list rather than spreading/filtering `undefined`. Items that
      // aren't cached edges (a `null` edge, a node cached without an id) are
      // kept in place; only `remove` needs to identify individual edges.
      const cachedEdges = connectionConfig.cacheEntry[EDGES_KEY];
      const currentEdges: unknown[] = Array.isArray(cachedEdges)
        ? cachedEdges
        : [];

      if (touched != null) {
        trackField(touched, connectionConfig.cacheEntry, EDGES_KEY);
      }

      if ("prepend" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...this.mapEdgesToCacheEntries(config.prepend, connectionConfig),
          ...currentEdges,
        ];
        return;
      }

      if ("append" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...currentEdges,
          ...this.mapEdgesToCacheEntries(config.append, connectionConfig),
        ];
        return;
      }

      const nodeIds = new Set(config.remove.map(String));
      connectionConfig.cacheEntry[EDGES_KEY] = currentEdges.filter((edge) => {
        if (!isCachedEdge(edge)) {
          return true;
        }

        const id = getIdFromCacheKey(edge[NODE_KEY]);
        return id == null || !nodeIds.has(id);
      });
    }
  }
}
