import {
  Kind,
  OperationTypeNode,
  type DocumentNode,
  type FieldNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import { Array as BoxedArray, Option, Result } from "@swan-io/boxed";
import {
  extractArguments,
  getCacheKeyFromOperationNode,
  getFieldName,
  getFieldNameWithArguments,
  getSelectedKeys,
  isExcluded,
} from "./graphql/ast";
import type { Connection, Edge } from "./types";
import {
  CONNECTION_REF,
  containsAll,
  deepEqual,
  EDGES_KEY,
  hasOwnProperty,
  isRecord,
  NODE_KEY,
  REQUESTED_KEYS,
  serializeVariables,
  TYPENAME_KEY,
} from "./utils";

export type SchemaConfig = {
  interfaceToTypes: Record<string, string[]>;
};

type CacheEntry = Record<symbol, unknown> & {
  [REQUESTED_KEYS]: Set<symbol>;
  [CONNECTION_REF]?: number;
};

type ConnectionInfo = {
  // useful for connection updates
  cacheEntry: CacheEntry;
  // to re-read from cache
  document: DocumentNode;
  variables: Record<string, unknown>;
  pathInQuery: PropertyKey[];
  fieldVariables: Record<string, unknown>;
};

export class ClientCache {
  cache = new Map<symbol, CacheEntry>();
  operationCache = new Map<
    DocumentNode,
    Map<string, Option<Result<unknown, unknown>>>
  >();

  interfaceToType: Record<string, Set<string>>;
  connectionCache: Map<number, ConnectionInfo>;
  connectionRefCount = -1;

  constructor(schemaConfig: SchemaConfig) {
    this.interfaceToType = Object.fromEntries(
      Object.entries(schemaConfig.interfaceToTypes).map(([key, value]) => [
        key,
        new Set(value),
      ]),
    );
    this.connectionCache = new Map<number, ConnectionInfo>();
  }

  registerConnectionInfo(info: ConnectionInfo) {
    const id = ++this.connectionRefCount;
    this.connectionCache.set(id, info);
    return id;
  }

  isTypeCompatible(typename: string, typeCondition: string) {
    if (typename === typeCondition) {
      return true;
    }
    const compatibleTypes = this.interfaceToType[typeCondition];
    if (compatibleTypes == undefined) {
      return false;
    }
    return compatibleTypes.has(typename);
  }

  dump() {
    return this.cache;
  }

  getOperationFromCache(
    documentNode: DocumentNode,
    variables: Record<string, unknown>,
  ) {
    const serializedVariables = serializeVariables(variables);
    return Option.fromNullable(this.operationCache.get(documentNode))
      .flatMap((cache) => Option.fromNullable(cache.get(serializedVariables)))
      .flatMap((value) => value);
  }

  setOperationInCache(
    documentNode: DocumentNode,
    variables: Record<string, unknown>,
    data: Result<unknown, unknown>,
  ) {
    const serializedVariables = serializeVariables(variables);
    const documentCache = Option.fromNullable(
      this.operationCache.get(documentNode),
    ).getOr(new Map());
    documentCache.set(serializedVariables, Option.Some(data));
    this.operationCache.set(documentNode, documentCache);
  }

  getFromCache(cacheKey: symbol, requestedKeys: Set<symbol>) {
    return this.get(cacheKey).flatMap((entry) => {
      if (isRecord(entry)) {
        if (containsAll(entry[REQUESTED_KEYS] as Set<symbol>, requestedKeys)) {
          return Option.Some(entry);
        } else {
          return Option.None();
        }
      } else {
        return Option.Some(entry);
      }
    });
  }

  getFromCacheWithoutKey(cacheKey: symbol) {
    return this.get(cacheKey).flatMap((entry) => {
      return Option.Some(entry);
    });
  }

  get(cacheKey: symbol): Option<unknown> {
    if (this.cache.has(cacheKey)) {
      return Option.Some(this.cache.get(cacheKey));
    } else {
      return Option.None();
    }
  }

  getOrCreateEntry(cacheKey: symbol, defaultValue: CacheEntry): unknown {
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as unknown;
    } else {
      const entry = defaultValue;
      this.cache.set(cacheKey, entry);
      return entry;
    }
  }

  set(cacheKey: symbol, entry: CacheEntry) {
    this.cache.set(cacheKey, entry);
  }

  updateConnection<A>(
    connection: Connection<A>,
    config:
      | { prepend: Edge<A>[] }
      | { append: Edge<A>[] }
      | { remove: string[] },
  ) {
    if (connection == null) {
      return;
    }
    if (
      CONNECTION_REF in connection &&
      typeof connection[CONNECTION_REF] === "number"
    ) {
      const connectionConfig = this.connectionCache.get(
        connection[CONNECTION_REF],
      );
      if (connectionConfig == null) {
        return;
      }

      if ("prepend" in config) {
        const edges = config.prepend;
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...BoxedArray.filterMap(edges, ({ node, __typename }) =>
            getCacheEntryKey(node).flatMap((key) =>
              // we can omit the requested fields here because the Connection<A> contrains the fields
              this.getFromCacheWithoutKey(key).map(() => ({
                [TYPENAME_KEY]: __typename,
                [NODE_KEY]: key,
              })),
            ),
          ),
          ...(connectionConfig.cacheEntry[EDGES_KEY] as unknown[]),
        ];
        return;
      }

      if ("append" in config) {
        const edges = config.append;
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...(connectionConfig.cacheEntry[EDGES_KEY] as unknown[]),
          ...BoxedArray.filterMap(edges, ({ node, __typename }) =>
            getCacheEntryKey(node).flatMap((key) =>
              // we can omit the requested fields here because the Connection<A> contrains the fields
              this.getFromCacheWithoutKey(key).map(() => ({
                [TYPENAME_KEY]: __typename,
                [NODE_KEY]: key,
              })),
            ),
          ),
        ];
        return;
      }
      const nodeIds = config.remove;
      connectionConfig.cacheEntry[EDGES_KEY] = (
        connectionConfig.cacheEntry[EDGES_KEY] as unknown[]
      ).filter((edge) => {
        // @ts-expect-error fine
        const node = edge[NODE_KEY] as symbol;
        return !nodeIds.some((nodeId) => {
          return node.description?.includes(`<${nodeId}>`);
        });
      });
    }
  }
}

// start: json directory content

const OPERATION_TYPES = new Set(["Query", "Mutation", "Subscription"]);

const getCacheEntryKey = (json: unknown): Option<symbol> => {
  if (typeof json === "object" && json != null) {
    if ("__typename" in json && typeof json.__typename === "string") {
      const typename = json.__typename;
      if (OPERATION_TYPES.has(typename)) {
        return Option.Some(Symbol.for(typename));
      }
      if ("id" in json && typeof json.id === "string") {
        return Option.Some(Symbol.for(`${typename}<${json.id}>`));
      }
    }
  }
  return Option.None();
};

const getTypename = (json: unknown): string | undefined => {
  if (typeof json === "object" && json != null) {
    if (Array.isArray(json)) {
      return getTypename(json[0]);
    }
    if ("__typename" in json && typeof json.__typename === "string") {
      return json.__typename;
    }
  }
};

// end: json directory content

// start: cache/entry content

const createEmptyCacheEntry = (): CacheEntry => ({
  [REQUESTED_KEYS]: new Set<symbol>(),
});

// end: cache/entry content

// start: cache/read content

const getFromCacheOrReturnValue = (
  cache: ClientCache,
  valueOrKey: unknown,
  selectedKeys: Set<symbol>,
): Option<unknown> => {
  if (typeof valueOrKey === "symbol") {
    return cache
      .getFromCache(valueOrKey, selectedKeys)
      .flatMap(Option.fromNullable);
  }
  if (
    isRecord(valueOrKey) &&
    REQUESTED_KEYS in valueOrKey &&
    valueOrKey[REQUESTED_KEYS] instanceof Set
  ) {
    if (containsAll(valueOrKey[REQUESTED_KEYS], selectedKeys)) {
      return Option.Some(valueOrKey);
    } else {
      return Option.None();
    }
  }
  return Option.Some(valueOrKey);
};

const STABILITY_CACHE = new WeakMap<DocumentNode, Map<string, unknown>>();

const EXCLUDED = Symbol.for("EXCLUDED");

export const readOperationFromCache = (
  cache: ClientCache,
  document: DocumentNode,
  variables: Record<string, unknown>,
) => {
  const traverse = (
    selections: SelectionSetNode,
    data: Record<PropertyKey, unknown>,
  ): Option<unknown> => {
    return selections.selections.reduce<Option<unknown>>((data, selection) => {
      return data.flatMap((data) => {
        if (selection.kind === Kind.FIELD) {
          const fieldNode = selection;
          const originalFieldName = getFieldName(fieldNode);
          const fieldNameWithArguments = getFieldNameWithArguments(
            fieldNode,
            variables,
          );

          if (data == undefined) {
            return Option.None();
          }

          const cacheHasKey =
            hasOwnProperty.call(data, originalFieldName) ||
            hasOwnProperty.call(data, fieldNameWithArguments);

          if (!cacheHasKey) {
            if (isExcluded(fieldNode, variables)) {
              return Option.Some({
                ...data,
                [originalFieldName]: EXCLUDED,
              });
            } else {
              return Option.None();
            }
          }

          // in case a the data is read across multiple selections, get the actual one if generated,
          // otherwise, read from cache (e.g. fragments)
          const valueOrKeyFromCache =
            // @ts-expect-error `data` is indexable at this point
            originalFieldName in data
              ? // @ts-expect-error `data` is indexable at this point
                data[originalFieldName]
              : // @ts-expect-error `data` is indexable at this point
                data[fieldNameWithArguments];

          if (valueOrKeyFromCache == undefined) {
            return Option.Some({
              ...data,
              [originalFieldName]: valueOrKeyFromCache,
            });
          }

          if (Array.isArray(valueOrKeyFromCache)) {
            const selectedKeys = getSelectedKeys(fieldNode, variables);
            return Option.all(
              valueOrKeyFromCache.map((valueOrKey) => {
                const value = getFromCacheOrReturnValue(
                  cache,
                  valueOrKey,
                  selectedKeys,
                );

                return value.flatMap((value) => {
                  if (isRecord(value) && fieldNode.selectionSet != undefined) {
                    return traverse(fieldNode.selectionSet, value);
                  } else {
                    return Option.Some(value);
                  }
                });
              }),
            ).map((result) => ({
              ...data,
              [originalFieldName]: result,
            }));
          } else {
            const selectedKeys = getSelectedKeys(fieldNode, variables);

            const value = getFromCacheOrReturnValue(
              cache,
              valueOrKeyFromCache,
              selectedKeys,
            );

            return value.flatMap((value) => {
              if (isRecord(value) && fieldNode.selectionSet != undefined) {
                return traverse(
                  fieldNode.selectionSet,
                  value as Record<PropertyKey, unknown>,
                ).map((result) => ({
                  ...data,
                  [originalFieldName]: result,
                }));
              } else {
                return Option.Some({ ...data, [originalFieldName]: value });
              }
            });
          }
        }
        if (selection.kind === Kind.INLINE_FRAGMENT) {
          const inlineFragmentNode = selection;
          const typeCondition = inlineFragmentNode.typeCondition?.name.value;
          const dataTypename = getTypename(data);

          if (typeCondition != null && dataTypename != null) {
            if (cache.isTypeCompatible(dataTypename, typeCondition)) {
              return traverse(
                inlineFragmentNode.selectionSet,
                data as Record<PropertyKey, unknown>,
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
                              return cache.isTypeCompatible(
                                dataTypename,
                                typeCondition,
                              );
                            }
                          }
                          return true;
                        },
                      ),
                  },
                  data as Record<PropertyKey, unknown>,
                );
              } else {
                return Option.Some(data);
              }
            }
          }
          return traverse(
            inlineFragmentNode.selectionSet,
            data as Record<PropertyKey, unknown>,
          );
        } else {
          return Option.None();
        }
      });
    }, Option.Some(data));
  };

  return BoxedArray.findMap(document.definitions, (definition) =>
    definition.kind === Kind.OPERATION_DEFINITION
      ? Option.Some(definition)
      : Option.None(),
  )
    .flatMap((operation) =>
      Option.fromNullable(getCacheKeyFromOperationNode(operation)).map(
        (cacheKey) => ({
          operation,
          cacheKey,
        }),
      ),
    )
    .flatMap(({ operation, cacheKey }) => {
      return cache
        .getFromCache(cacheKey, getSelectedKeys(operation, variables))
        .map((cache) => ({ cache, operation }));
    })
    .flatMap(({ operation, cache }) => {
      return traverse(
        operation.selectionSet,
        cache as Record<PropertyKey, unknown>,
      );
    })
    .map((data) => JSON.parse(JSON.stringify(data)))
    .flatMap((value) => {
      // We use a trick to return stable values, the document holds a WeakMap
      // that for each key (serialized variables), stores the last returned result.
      // If the last value deeply equals the previous one, return the previous one
      const serializedVariables = serializeVariables(variables);
      const previous = Option.fromNullable(STABILITY_CACHE.get(document))
        .flatMap((byVariable) =>
          Option.fromNullable(byVariable.get(serializedVariables)),
        )
        .flatMap((value) => value as Option<Result<unknown, unknown>>);

      if (
        previous
          .flatMap((previous) => previous.toOption())
          .map((previous) => deepEqual(value, previous))
          .getOr(false)
      ) {
        return previous;
      } else {
        const valueToCache = Option.Some(Result.Ok(value));
        const documentCache = STABILITY_CACHE.get(document) ?? new Map();
        documentCache.set(serializedVariables, valueToCache);
        STABILITY_CACHE.set(document, documentCache);
        return valueToCache;
      }
    });
};

// end: cache/read content

// start: cache/write content

export const writeOperationToCache = (
  cache: ClientCache,
  document: DocumentNode,
  response: unknown,
  variables: Record<string, unknown>,
) => {
  const registerConnection = (
    cacheEntry: CacheEntry,
    pathInQuery: PropertyKey[],
    fieldVariables: Record<string, unknown>,
  ) => {
    if (cacheEntry[CONNECTION_REF]) {
      return;
    }
    const id = cache.registerConnectionInfo({
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
  ) => {
    const originalFieldName = getFieldName(field);
    const fieldNameWithArguments = getFieldNameWithArguments(field, variables);
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
        const cacheEntry = cacheKey.map((key) =>
          cache.getOrCreateEntry(key, createEmptyCacheEntry()),
        );
        const cacheObject = cacheEntry.getOr(
          // @ts-expect-error It's fine
          arrayCache[index] ?? createEmptyCacheEntry(),
        ) as CacheEntry;

        // @ts-expect-error It's fine
        const cacheValueInParent = cacheKey.getOr(cacheObject);
        // @ts-expect-error It's fine
        arrayCache[index] = cacheValueInParent;

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
    const cacheEntry = cacheKey.map((key) =>
      cache.getOrCreateEntry(key, createEmptyCacheEntry()),
    );
    const cacheObject = cacheEntry.getOr(
      parentCache[fieldNameWithArguments] ?? createEmptyCacheEntry(),
    ) as CacheEntry;

    // @ts-expect-error It's fine
    const cacheValueInParent = cacheKey.getOr(cacheObject);
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
  ) => {
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

      const cacheEntry = cache.getOrCreateEntry(
        Symbol.for(operationName),
        createEmptyCacheEntry(),
      );
      return cacheSelectionSet(
        definition.selectionSet,
        response,
        cacheEntry as CacheEntry,
        [],
      );
    }
  });
};

// end: cache/write content
