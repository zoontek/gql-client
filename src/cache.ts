import {
  Kind,
  OperationTypeNode,
  type FieldNode,
  type InlineFragmentNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  extractArguments,
  getCacheEntryKey,
  getCacheKeyFromOperationNode,
  getFieldName,
  getFieldNameWithArguments,
  getSelectedKeys,
  getTypename,
  isExcluded,
} from "./graphql/ast";
import type { AnyVariables, Connection, Edge, JsonValue } from "./types";
import {
  CONNECTION_REF,
  CURSOR_KEY,
  EDGES_KEY,
  NODE_KEY,
  REQUESTED_KEYS,
  TYPENAME_KEY,
  containsAll,
  deepEqual,
  filterMap,
  hasOwn,
  isRecord,
  serializeVariables,
} from "./utils";

// Sentinel used internally to signal a cache miss. It is distinct from a cached
// `null`/`undefined` value, which are legitimate results that must be preserved.
const MISS = Symbol("MISS");

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

type CacheEntry = Record<symbol, unknown> & {
  [REQUESTED_KEYS]: Set<symbol>;
  [CONNECTION_REF]?: number;
};

const createEmptyCacheEntry = (): CacheEntry => ({
  [REQUESTED_KEYS]: new Set<symbol>(),
});

const STABILITY_CACHE = new WeakMap<
  TypedDocumentNode,
  Map<string, JsonValue>
>();

type CachedEdge = {
  [TYPENAME_KEY]: string | null | undefined;
  [NODE_KEY]: symbol;
  [CURSOR_KEY]?: string | null | undefined;
};

export class ClientCache {
  private cache = new Map<symbol, CacheEntry>();
  private interfaceToType: Record<string, Set<string>>;
  private connectionCache: Map<number, ConnectionInfo>;
  private connectionRefCount = -1;

  public constructor(schema: Schema) {
    this.interfaceToType = Object.fromEntries(
      Object.entries(schema.interfaceToTypes).map(([key, value]) => [
        key,
        new Set<string>(value),
      ]),
    );
    this.connectionCache = new Map<number, ConnectionInfo>();
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

  private getFromCache(cacheKey: symbol, requestedKeys: Set<symbol>): unknown {
    const entry = this.get(cacheKey);

    // `entry` is either a record cache entry, a scalar, or the MISS sentinel
    // (a symbol, so it falls through to the return below).
    if (isRecord(entry)) {
      return containsAll(entry[REQUESTED_KEYS] as Set<symbol>, requestedKeys)
        ? entry
        : MISS;
    }

    return entry;
  }

  private get(cacheKey: symbol): unknown {
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
      const currentEdges =
        (connectionConfig.cacheEntry[EDGES_KEY] as CachedEdge[] | undefined) ??
        [];

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

  private getFromCacheOrReturnValue(
    valueOrKey: unknown,
    selectedKeys: Set<symbol>,
  ): unknown {
    if (typeof valueOrKey === "symbol") {
      const entry = this.getFromCache(valueOrKey, selectedKeys);
      return entry === MISS || entry == null ? MISS : entry;
    }
    if (
      isRecord(valueOrKey) &&
      REQUESTED_KEYS in valueOrKey &&
      valueOrKey[REQUESTED_KEYS] instanceof Set
    ) {
      if (containsAll(valueOrKey[REQUESTED_KEYS], selectedKeys)) {
        return valueOrKey;
      } else {
        return MISS;
      }
    }
    return valueOrKey;
  }

  public readOperation(
    document: TypedDocumentNode,
    variables: AnyVariables,
  ): JsonValue | undefined {
    // Builds a clean, string-keyed result directly. `source` is read-only — a
    // cache entry (whose field values live under argument-qualified symbol
    // keys) or a previously-resolved plain object (string keys, hit when a
    // field is shared across selections). Values are written into a fresh
    // `result`, so the output never carries the internal symbol-keyed metadata
    // and needs no separate cloning/stripping pass.
    const applyField = (
      fieldNode: FieldNode,
      source: Record<PropertyKey, unknown>,
      result: Record<PropertyKey, unknown>,
    ): boolean => {
      const originalFieldName = getFieldName(fieldNode);
      const fieldNameWithArguments = getFieldNameWithArguments(
        fieldNode,
        variables,
      );

      // Already resolved by an earlier selection (e.g. a field shared between
      // the base selection and an inline fragment).
      const alreadyResolved = originalFieldName in result;
      const cacheHasKey =
        alreadyResolved ||
        hasOwn(source, originalFieldName) ||
        hasOwn(source, fieldNameWithArguments);

      if (!cacheHasKey) {
        // A field excluded by `@include(if: false)` / `@skip(if: true)` is
        // absent from the response, so its absence from the cache is not a
        // miss — skip it. Any other missing field is a genuine miss.
        return isExcluded(fieldNode, variables);
      }

      const rawValue = alreadyResolved
        ? result[originalFieldName]
        : hasOwn(source, originalFieldName)
          ? source[originalFieldName]
          : source[fieldNameWithArguments];

      if (rawValue == undefined) {
        // Preserve a cached `null`; drop `undefined` (matches JSON output).
        if (rawValue === null) {
          result[originalFieldName] = null;
        }
        return true;
      }

      const selectedKeys = getSelectedKeys(fieldNode, variables);

      // Resolve a single cached value or key: pull it from the cache, then
      // recurse into any nested selection set. Returns MISS on a cache miss.
      const resolve = (valueOrKey: unknown): unknown => {
        const value = this.getFromCacheOrReturnValue(valueOrKey, selectedKeys);

        if (value === MISS) {
          return MISS;
        }

        if (isRecord(value) && fieldNode.selectionSet != undefined) {
          // oxlint-disable-next-line no-use-before-define
          return traverse(fieldNode.selectionSet, value);
        }

        return value;
      };

      if (Array.isArray(rawValue)) {
        const items: unknown[] = [];

        for (const valueOrKey of rawValue) {
          const value = resolve(valueOrKey);

          if (value === MISS) {
            return false;
          }

          items.push(value === undefined ? null : value);
        }

        result[originalFieldName] = items;
        return true;
      }

      const value = resolve(rawValue);

      if (value === MISS) {
        return false;
      }

      result[originalFieldName] = value;
      return true;
    };

    const applyInlineFragment = (
      inlineFragmentNode: InlineFragmentNode,
      source: Record<PropertyKey, unknown>,
      result: Record<PropertyKey, unknown>,
    ): boolean => {
      const typeCondition = inlineFragmentNode.typeCondition?.name.value;
      // `__typename` is selected first in every selection set, so by the time
      // we reach an inline fragment it has already been written to `result`.
      const dataTypename = getTypename(result);

      if (typeCondition != null && dataTypename != null) {
        if (this.isTypeCompatible(dataTypename, typeCondition)) {
          // oxlint-disable-next-line no-use-before-define
          return applySelections(
            inlineFragmentNode.selectionSet,
            source,
            result,
          );
        }

        // Incompatible type condition: if it nests inline fragments, keep only
        // the ones still compatible with the concrete type; otherwise skip.
        if (
          inlineFragmentNode.selectionSet.selections.some(
            (selection) => selection.kind === Kind.INLINE_FRAGMENT,
          )
        ) {
          // oxlint-disable-next-line no-use-before-define
          return applySelections(
            {
              ...inlineFragmentNode.selectionSet,
              selections: inlineFragmentNode.selectionSet.selections.filter(
                (selection) => {
                  if (selection.kind === Kind.INLINE_FRAGMENT) {
                    const nestedTypeCondition =
                      selection.typeCondition?.name.value;
                    return (
                      nestedTypeCondition == null ||
                      this.isTypeCompatible(dataTypename, nestedTypeCondition)
                    );
                  }
                  return true;
                },
              ),
            },
            source,
            result,
          );
        }

        return true;
      }

      // oxlint-disable-next-line no-use-before-define
      return applySelections(inlineFragmentNode.selectionSet, source, result);
    };

    const applySelections = (
      selectionSet: SelectionSetNode,
      source: Record<PropertyKey, unknown>,
      result: Record<PropertyKey, unknown>,
    ): boolean => {
      if (source == undefined) {
        return false;
      }

      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (!applyField(selection, source, result)) {
            return false;
          }
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          if (!applyInlineFragment(selection, source, result)) {
            return false;
          }
        } else {
          return false;
        }
      }

      return true;
    };

    const traverse = (
      selections: SelectionSetNode,
      source: Record<PropertyKey, unknown>,
    ): unknown => {
      const result: Record<PropertyKey, unknown> = {};

      if (!applySelections(selections, source, result)) {
        return MISS;
      }

      // Carry over the connection reference (a string key, not a queried
      // field) so consumers — `useForwardPagination`/`useBackwardPagination`
      // and `updateConnection` — can locate the registered connection.
      if (hasOwn(source, CONNECTION_REF)) {
        result[CONNECTION_REF] = source[CONNECTION_REF];
      }

      return result;
    };

    const operation = document.definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );

    if (operation === undefined) {
      return undefined;
    }

    const cacheKey = getCacheKeyFromOperationNode(operation);

    if (cacheKey === undefined) {
      return undefined;
    }

    const cache = this.getFromCache(
      cacheKey,
      getSelectedKeys(operation, variables),
    );

    if (cache === MISS) {
      return undefined;
    }

    const traversed = traverse(
      operation.selectionSet,
      cache as Record<PropertyKey, unknown>,
    );

    if (traversed === MISS) {
      return undefined;
    }

    // `traverse` already produced a clean, string-keyed plain-JSON tree.
    const value = traversed as JsonValue;

    // We use a trick to return stable values, the document holds a WeakMap
    // that for each key (serialized variables), stores the last returned result.
    // If the last value deeply equals the previous one, return the previous one
    const serializedVariables = serializeVariables(variables);
    const documentCache = STABILITY_CACHE.get(document);
    const previous = documentCache?.get(serializedVariables);

    if (previous !== undefined && deepEqual(value, previous)) {
      return previous;
    }

    const nextDocumentCache = documentCache ?? new Map<string, JsonValue>();
    nextDocumentCache.set(serializedVariables, value);
    STABILITY_CACHE.set(document, nextDocumentCache);
    return value;
  }

  public writeOperation(
    document: TypedDocumentNode,
    response: JsonValue,
    variables: AnyVariables,
  ): void {
    const registerConnection = (
      cacheEntry: CacheEntry,
      pathInQuery: PropertyKey[],
      fieldVariables: AnyVariables,
    ): void => {
      if (cacheEntry[CONNECTION_REF]) {
        return;
      }
      const id = this.registerConnectionInfo({
        cacheEntry,
        variables,
        pathInQuery,
        fieldVariables,
        document,
      });
      cacheEntry[CONNECTION_REF] = id;
    };

    const cacheField = (
      field: FieldNode,
      parentJson: Record<PropertyKey, unknown>,
      parentCache: CacheEntry,
      path: PropertyKey[],
    ): void => {
      const originalFieldName = getFieldName(field);
      const fieldNameWithArguments = getFieldNameWithArguments(
        field,
        variables,
      );
      const fieldValue = parentJson[originalFieldName];

      if (parentCache[REQUESTED_KEYS] != undefined) {
        parentCache[REQUESTED_KEYS].add(fieldNameWithArguments);
      } else {
        console.error(
          `GraphQL Client cache error: ${path.join(".")} likely didn't query its \`id\` field`,
        );
      }

      // either scalar type with no selection, or a null/undefined value
      const subSelectionSet = field.selectionSet;
      if (subSelectionSet === undefined || fieldValue == null) {
        parentCache[fieldNameWithArguments] = fieldValue;
        return;
      }
      // array with selection
      if (Array.isArray(fieldValue)) {
        const arrayCache = (parentCache[fieldNameWithArguments] ??
          Array(fieldValue.length)) as (symbol | CacheEntry | null)[];
        arrayCache.length = fieldValue.length;
        if (parentCache[fieldNameWithArguments] == undefined) {
          parentCache[fieldNameWithArguments] = arrayCache;
        }
        fieldValue.forEach((item, index) => {
          if (item == null) {
            arrayCache[index] = item;
            return;
          }
          const cacheKey = getCacheEntryKey(item);
          const cacheObject =
            cacheKey !== undefined
              ? this.getOrCreateEntry(cacheKey)
              : ((arrayCache[index] as CacheEntry | undefined) ??
                createEmptyCacheEntry());

          const cacheValueInParent = cacheKey ?? cacheObject;
          arrayCache[index] = cacheValueInParent;

          // oxlint-disable-next-line no-use-before-define
          cacheSelectionSet(subSelectionSet, item, cacheObject, [
            ...path,
            originalFieldName,
            index,
          ]);
        });
        return;
      }
      // object with selection
      const record = fieldValue as Record<PropertyKey, unknown>;
      const cacheKey = getCacheEntryKey(record);
      const cacheObject =
        cacheKey !== undefined
          ? this.getOrCreateEntry(cacheKey)
          : ((parentCache[fieldNameWithArguments] as CacheEntry | undefined) ??
            createEmptyCacheEntry());

      const cacheValueInParent = cacheKey ?? cacheObject;
      parentCache[fieldNameWithArguments] = cacheValueInParent;

      if (
        typeof record.__typename === "string" &&
        record.__typename.endsWith("Connection")
      ) {
        registerConnection(
          cacheObject,
          [...path, originalFieldName],
          extractArguments(field, variables),
        );
      }

      // oxlint-disable-next-line no-use-before-define
      return cacheSelectionSet(subSelectionSet, record, cacheObject, [
        ...path,
        originalFieldName,
      ]);
    };

    const cacheSelectionSet = (
      selectionSet: SelectionSetNode,
      json: Record<PropertyKey, unknown>,
      cached: CacheEntry,
      path: PropertyKey[],
    ): void => {
      for (const selection of selectionSet.selections) {
        switch (selection.kind) {
          case Kind.INLINE_FRAGMENT:
            cacheSelectionSet(selection.selectionSet, json, cached, path);
            continue;
          case Kind.FIELD:
            cacheField(selection, json, cached, path);
            continue;
          default:
            continue;
        }
      }
    };

    const operation = document.definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );

    if (operation === undefined || !isRecord(response)) {
      return;
    }

    // Root __typename can vary, but we can't guess it from the document alone
    const operationName =
      operation.operation === OperationTypeNode.QUERY
        ? "Query"
        : operation.operation === OperationTypeNode.SUBSCRIPTION
          ? "Subscription"
          : "Mutation";

    const cacheEntry = this.getOrCreateEntry(Symbol.for(operationName));
    cacheSelectionSet(operation.selectionSet, response, cacheEntry, []);
  }
}
