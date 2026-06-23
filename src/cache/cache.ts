import {
  Kind,
  OperationTypeNode,
  type FieldNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  extractArguments,
  getCacheKeyFromOperationNode,
  getFieldName,
  getFieldNameWithArguments,
  getSelectedKeys,
  isExcluded,
} from "../graphql/ast";
import { getCacheEntryKey } from "../json/cacheEntryKey";
import { getTypename } from "../json/getTypename";
import type { AnyVariables, Connection, Edge, JsonValue } from "../types";
import {
  CONNECTION_REF,
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
} from "../utils";
import { createEmptyCacheEntry, type CacheEntry } from "./entry";

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

const STABILITY_CACHE = new WeakMap<
  TypedDocumentNode,
  Map<string, JsonValue>
>();

const EXCLUDED = Symbol.for("EXCLUDED");

// Sentinel used internally to signal a cache miss. It is distinct from a cached
// `null`/`undefined` value, which are legitimate results that must be preserved.
const MISS = Symbol("MISS");

type CachedEdge = {
  [TYPENAME_KEY]: string | null | undefined;
  [NODE_KEY]: symbol;
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
    if (entry === MISS) {
      return MISS;
    }
    if (isRecord(entry)) {
      if (containsAll(entry[REQUESTED_KEYS] as Set<symbol>, requestedKeys)) {
        return entry;
      } else {
        return MISS;
      }
    } else {
      return entry;
    }
  }

  private get(cacheKey: symbol): unknown {
    const entry = this.cache.get(cacheKey);
    return entry === undefined ? MISS : entry;
  }

  private getOrCreateEntry(
    cacheKey: symbol,
    defaultValue: CacheEntry,
  ): CacheEntry {
    const cached = this.cache.get(cacheKey);

    if (cached != null) {
      return cached;
    } else {
      const entry = defaultValue;
      this.cache.set(cacheKey, entry);
      return entry;
    }
  }

  private mapEdgesToCacheEntries<A>(edges: Edge<A>[]): CachedEdge[] {
    return filterMap(edges, ({ node, __typename }) => {
      const key = getCacheEntryKey(node);
      // we can omit the requested fields here because the Connection<A> contrains the fields
      if (key === undefined || this.get(key) === MISS) {
        return undefined;
      }
      return {
        [TYPENAME_KEY]: __typename,
        [NODE_KEY]: key,
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

      if ("prepend" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...this.mapEdgesToCacheEntries(config.prepend),
          ...(connectionConfig.cacheEntry[EDGES_KEY] as CachedEdge[]),
        ];
        return;
      }

      if ("append" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...(connectionConfig.cacheEntry[EDGES_KEY] as CachedEdge[]),
          ...this.mapEdgesToCacheEntries(config.append),
        ];
        return;
      }

      const nodeIds = new Set(config.remove);
      connectionConfig.cacheEntry[EDGES_KEY] = (
        connectionConfig.cacheEntry[EDGES_KEY] as CachedEdge[]
      ).filter((edge) => {
        const description = edge[NODE_KEY].description;

        if (description === undefined) {
          return true;
        }

        // Cache keys are `${typename}<${id}>`. Match the id segment exactly so
        // `"1"` doesn't accidentally remove `"11"` or an id that happens to
        // appear elsewhere in the key.
        const match = /<([^<>]*)>$/.exec(description);
        return match === null || !nodeIds.has(match[1] as string);
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
    const traverse = (
      selections: SelectionSetNode,
      data: Record<PropertyKey, unknown>,
    ): unknown => {
      return selections.selections.reduce<unknown>((acc, selection) => {
        if (acc === MISS) {
          return MISS;
        }
        if (selection.kind === Kind.FIELD) {
          const fieldNode = selection;
          const originalFieldName = getFieldName(fieldNode);
          const fieldNameWithArguments = getFieldNameWithArguments(
            fieldNode,
            variables,
          );

          if (acc == undefined) {
            return MISS;
          }

          const cacheHasKey =
            hasOwn(acc, originalFieldName) ||
            hasOwn(acc, fieldNameWithArguments);

          if (!cacheHasKey) {
            if (isExcluded(fieldNode, variables)) {
              return {
                ...acc,
                [originalFieldName]: EXCLUDED,
              };
            } else {
              return MISS;
            }
          }

          // in case a the data is read across multiple selections, get the actual one if generated,
          // otherwise, read from cache (e.g. fragments)
          const valueOrKeyFromCache =
            // @ts-expect-error `acc` is indexable at this point
            originalFieldName in acc
              ? // @ts-expect-error `acc` is indexable at this point
                acc[originalFieldName]
              : // @ts-expect-error `acc` is indexable at this point
                acc[fieldNameWithArguments];

          if (valueOrKeyFromCache == undefined) {
            return {
              ...acc,
              [originalFieldName]: valueOrKeyFromCache,
            };
          }

          if (Array.isArray(valueOrKeyFromCache)) {
            const selectedKeys = getSelectedKeys(fieldNode, variables);
            const result: unknown[] = [];

            for (const valueOrKey of valueOrKeyFromCache) {
              const value = this.getFromCacheOrReturnValue(
                valueOrKey,
                selectedKeys,
              );

              if (value === MISS) {
                return MISS;
              }

              if (isRecord(value) && fieldNode.selectionSet != undefined) {
                const traversed = traverse(fieldNode.selectionSet, value);
                if (traversed === MISS) {
                  return MISS;
                }
                result.push(traversed);
              } else {
                result.push(value);
              }
            }

            return {
              ...acc,
              [originalFieldName]: result,
            };
          } else {
            const selectedKeys = getSelectedKeys(fieldNode, variables);

            const value = this.getFromCacheOrReturnValue(
              valueOrKeyFromCache,
              selectedKeys,
            );

            if (value === MISS) {
              return MISS;
            }

            if (isRecord(value) && fieldNode.selectionSet != undefined) {
              const result = traverse(fieldNode.selectionSet, value);
              if (result === MISS) {
                return MISS;
              }
              return {
                ...acc,
                [originalFieldName]: result,
              };
            } else {
              return { ...acc, [originalFieldName]: value };
            }
          }
        }
        if (selection.kind === Kind.INLINE_FRAGMENT) {
          const inlineFragmentNode = selection;
          const typeCondition = inlineFragmentNode.typeCondition?.name.value;
          const dataTypename = getTypename(acc);

          if (typeCondition != null && dataTypename != null) {
            if (this.isTypeCompatible(dataTypename, typeCondition)) {
              return traverse(
                inlineFragmentNode.selectionSet,
                acc as Record<PropertyKey, unknown>,
              );
            } else {
              if (
                inlineFragmentNode.selectionSet.selections.some(
                  (selection) => selection.kind === Kind.INLINE_FRAGMENT,
                )
              ) {
                return traverse(
                  {
                    ...inlineFragmentNode.selectionSet,
                    selections:
                      inlineFragmentNode.selectionSet.selections.filter(
                        (selection) => {
                          if (selection.kind === Kind.INLINE_FRAGMENT) {
                            const typeCondition =
                              selection.typeCondition?.name.value;
                            if (typeCondition == null) {
                              return true;
                            } else {
                              return this.isTypeCompatible(
                                dataTypename,
                                typeCondition,
                              );
                            }
                          }
                          return true;
                        },
                      ),
                  },
                  acc as Record<PropertyKey, unknown>,
                );
              } else {
                return acc;
              }
            }
          }
          return traverse(
            inlineFragmentNode.selectionSet,
            acc as Record<PropertyKey, unknown>,
          );
        } else {
          return MISS;
        }
      }, data);
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

    const value = JSON.parse(JSON.stringify(traversed)) as JsonValue;

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
        const arrayCache =
          parentCache[fieldNameWithArguments] ?? Array(fieldValue.length);
        // @ts-expect-error it's an array
        arrayCache.length = fieldValue.length;
        if (parentCache[fieldNameWithArguments] == undefined) {
          parentCache[fieldNameWithArguments] = arrayCache;
        }
        fieldValue.forEach((item, index) => {
          if (item == null) {
            // @ts-expect-error It's fine
            arrayCache[index] = item;
            return;
          }
          const cacheKey = getCacheEntryKey(item);
          const cacheObject =
            cacheKey !== undefined
              ? this.getOrCreateEntry(cacheKey, createEmptyCacheEntry())
              : // @ts-expect-error It's fine
                (arrayCache[index] ?? createEmptyCacheEntry());

          const cacheValueInParent = cacheKey ?? cacheObject;
          // @ts-expect-error It's fine
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
          ? this.getOrCreateEntry(cacheKey, createEmptyCacheEntry())
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

    document.definitions.forEach((definition) => {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        // Root __typename can vary, but we can't guess it from the document alone
        const operationName =
          definition.operation === OperationTypeNode.QUERY
            ? "Query"
            : definition.operation === OperationTypeNode.SUBSCRIPTION
              ? "Subscription"
              : "Mutation";

        if (!isRecord(response)) {
          return;
        }

        const cacheEntry = this.getOrCreateEntry(
          Symbol.for(operationName),
          createEmptyCacheEntry(),
        );
        return cacheSelectionSet(
          definition.selectionSet,
          response,
          cacheEntry,
          [],
        );
      }
    });
  }
}
