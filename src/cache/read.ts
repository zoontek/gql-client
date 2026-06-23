import {
  Kind,
  type DocumentNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import { Array, Option, Result } from "@bloodyowl/boxed";
import {
  getCacheKeyFromOperationNode,
  getFieldName,
  getFieldNameWithArguments,
  getSelectedKeys,
  isExcluded,
} from "../graphql/ast";
import { getTypename } from "../json/getTypename";
import {
  REQUESTED_KEYS,
  containsAll,
  deepEqual,
  hasOwnProperty,
  isRecord,
  serializeVariables,
} from "../utils";
import { ClientCache } from "./cache";

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

  return Array.findMap(document.definitions, (definition) =>
    definition.kind === Kind.OPERATION_DEFINITION
      ? Option.Some(definition)
      : Option.None(),
  )
    .flatMap((operation) =>
      getCacheKeyFromOperationNode(operation).map((cacheKey) => ({
        operation,
        cacheKey,
      })),
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
