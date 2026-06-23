import {
  Kind,
  OperationTypeNode,
  type FieldNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import { Option, Result } from "@bloodyowl/boxed";
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
import type { AnyVariables, Connection, Edge } from "../types";
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

export type SchemaConfig = {
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

const STABILITY_CACHE = new WeakMap<TypedDocumentNode, Map<string, unknown>>();

const EXCLUDED = Symbol.for("EXCLUDED");

export class ClientCache {
  private cache = new Map<symbol, CacheEntry>();

  private operationCache = new Map<
    TypedDocumentNode,
    Map<string, Option<Result<unknown, unknown>>>
  >();

  private interfaceToType: Record<string, Set<string>>;
  private connectionCache: Map<number, ConnectionInfo>;
  private connectionRefCount = -1;

  public constructor(schemaConfig: SchemaConfig) {
    this.interfaceToType = Object.fromEntries(
      Object.entries(schemaConfig.interfaceToTypes).map(([key, value]) => [
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

  public getOperationFromCache(
    documentNode: TypedDocumentNode,
    variables: AnyVariables,
  ): Option<Result<unknown, unknown>> {
    const serializedVariables = serializeVariables(variables);
    return Option.fromNullable(this.operationCache.get(documentNode))
      .flatMap((cache) => Option.fromNullable(cache.get(serializedVariables)))
      .flatMap((value) => value);
  }

  public setOperationInCache(
    documentNode: TypedDocumentNode,
    variables: AnyVariables,
    data: Result<unknown, unknown>,
  ): void {
    const serializedVariables = serializeVariables(variables);
    const documentCache = Option.fromNullable(
      this.operationCache.get(documentNode),
    ).getOr(new Map<string, Option<Result<unknown, unknown>>>());
    documentCache.set(serializedVariables, Option.Some(data));
    this.operationCache.set(documentNode, documentCache);
  }

  private getFromCache(
    cacheKey: symbol,
    requestedKeys: Set<symbol>,
  ): Option<unknown> {
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

  private getFromCacheWithoutKey(cacheKey: symbol): Option<unknown> {
    return this.get(cacheKey).flatMap((entry) => Option.Some(entry));
  }

  private get(cacheKey: symbol): Option<unknown> {
    return Option.fromUndefined(this.cache.get(cacheKey));
  }

  private getOrCreateEntry(
    cacheKey: symbol,
    defaultValue: CacheEntry,
  ): unknown {
    const cached = this.cache.get(cacheKey);

    if (cached != null) {
      return cached;
    } else {
      const entry = defaultValue;
      this.cache.set(cacheKey, entry);
      return entry;
    }
  }

  private mapEdgesToCacheEntries<A>(edges: Edge<A>[]): {
    [TYPENAME_KEY]: string | null | undefined;
    [NODE_KEY]: symbol;
  }[] {
    return filterMap(edges, ({ node, __typename }) =>
      getCacheEntryKey(node).flatMap((key) =>
        // we can omit the requested fields here because the Connection<A> contrains the fields
        this.getFromCacheWithoutKey(key).map(() => ({
          [TYPENAME_KEY]: __typename,
          [NODE_KEY]: key,
        })),
      ),
    );
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
          ...(connectionConfig.cacheEntry[EDGES_KEY] as unknown[]),
        ];
        return;
      }

      if ("append" in config) {
        connectionConfig.cacheEntry[EDGES_KEY] = [
          ...(connectionConfig.cacheEntry[EDGES_KEY] as unknown[]),
          ...this.mapEdgesToCacheEntries(config.append),
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

  private getFromCacheOrReturnValue(
    valueOrKey: unknown,
    selectedKeys: Set<symbol>,
  ): Option<unknown> {
    if (typeof valueOrKey === "symbol") {
      return this.getFromCache(valueOrKey, selectedKeys).flatMap(
        Option.fromNullable,
      );
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
  }

  public readOperation(
    document: TypedDocumentNode,
    variables: AnyVariables,
  ): Option<Result<unknown, unknown>> {
    const traverse = (
      selections: SelectionSetNode,
      data: Record<PropertyKey, unknown>,
    ): Option<unknown> => {
      return selections.selections.reduce<Option<unknown>>(
        (data, selection) => {
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
                hasOwn(data, originalFieldName) ||
                hasOwn(data, fieldNameWithArguments);

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
                    const value = this.getFromCacheOrReturnValue(
                      valueOrKey,
                      selectedKeys,
                    );

                    return value.flatMap((value) => {
                      if (
                        isRecord(value) &&
                        fieldNode.selectionSet != undefined
                      ) {
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

                const value = this.getFromCacheOrReturnValue(
                  valueOrKeyFromCache,
                  selectedKeys,
                );

                return value.flatMap((value) => {
                  if (isRecord(value) && fieldNode.selectionSet != undefined) {
                    return traverse(fieldNode.selectionSet, value).map(
                      (result) => ({
                        ...data,
                        [originalFieldName]: result,
                      }),
                    );
                  } else {
                    return Option.Some({ ...data, [originalFieldName]: value });
                  }
                });
              }
            }
            if (selection.kind === Kind.INLINE_FRAGMENT) {
              const inlineFragmentNode = selection;
              const typeCondition =
                inlineFragmentNode.typeCondition?.name.value;
              const dataTypename = getTypename(data);

              if (typeCondition != null && dataTypename != null) {
                if (this.isTypeCompatible(dataTypename, typeCondition)) {
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
        },
        Option.Some(data),
      );
    };

    return Option.fromNullable(
      document.definitions.find(
        (definition) => definition.kind === Kind.OPERATION_DEFINITION,
      ),
    )
      .flatMap((operation) =>
        getCacheKeyFromOperationNode(operation).map((cacheKey) => ({
          operation,
          cacheKey,
        })),
      )
      .flatMap(({ operation, cacheKey }) => {
        return this.getFromCache(
          cacheKey,
          getSelectedKeys(operation, variables),
        ).map((cache) => ({ cache, operation }));
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
          const documentCache =
            STABILITY_CACHE.get(document) ?? new Map<string, unknown>();
          documentCache.set(serializedVariables, valueToCache);
          STABILITY_CACHE.set(document, documentCache);
          return valueToCache;
        }
      });
  }

  public writeOperation(
    document: TypedDocumentNode,
    response: unknown,
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
          const cacheEntry = cacheKey.map((key) =>
            this.getOrCreateEntry(key, createEmptyCacheEntry()),
          );
          const cacheObject = cacheEntry.getOr(
            // @ts-expect-error It's fine
            arrayCache[index] ?? createEmptyCacheEntry(),
          ) as CacheEntry;

          // @ts-expect-error It's fine
          const cacheValueInParent = cacheKey.getOr(cacheObject);
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
      const cacheEntry = cacheKey.map((key) =>
        this.getOrCreateEntry(key, createEmptyCacheEntry()),
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
          cacheEntry as CacheEntry,
          [],
        );
      }
    });
  }
}
