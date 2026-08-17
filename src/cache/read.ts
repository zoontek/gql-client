import {
  Kind,
  type FieldNode,
  type InlineFragmentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import {
  getFieldName,
  getFieldNameWithArguments,
  getOperationDefinition,
  getTypename,
  isExcluded,
} from "../graphql/ast";
import { transformDocument } from "../graphql/transform";
import type { AnyVariables, JsonValue } from "../types";
import {
  containsAll,
  deepCopy,
  deepEqual,
  hasOwn,
  isRecord,
  serializeVariables,
} from "../utils";
import {
  CONNECTION_REF,
  getCacheKeyFromOperationNode,
  REQUESTED_KEYS,
  TYPENAME_KEY,
} from "./keys";
import { isCacheEntry, MISS, type CacheEntry } from "./types";
import { trackField } from "./watch";

const STABILITY_CACHE = new WeakMap<
  TypedDocumentNode,
  Map<string, JsonValue>
>();

export type ReadDeps = {
  // Raw map lookup, defaulting to MISS. Shared with the write and
  // connection-update paths, so it lives on the class instead of being
  // duplicated here.
  get: (cacheKey: symbol) => CacheEntry | typeof MISS;
  isTypeCompatible: (typename: string, typeCondition: string) => boolean;
};

export const createReadOperation = (
  deps: ReadDeps,
): (<Data, Variables extends AnyVariables>(
  document: TypedDocumentNode<Data, Variables>,
  variables: Variables,
  watched?: Map<object, Set<symbol>>,
) => JsonValue | undefined) => {
  // The field symbols an entry must hold under REQUESTED_KEYS to satisfy
  // `node`'s selection set, given the entry's concrete typename: fields
  // excluded by `@include`/`@skip` are not required, and neither are fields
  // under an inline fragment whose type condition is incompatible with that
  // typename. The write path skips both (see write.ts), so requiring them
  // would turn every such entry into a permanent miss. Memoized per
  // (node, variables, typename); kept in the factory closure because the
  // type compatibility answer depends on this client's schema config.
  const requiredKeysCache = new WeakMap<
    FieldNode | OperationDefinitionNode,
    WeakMap<AnyVariables, Map<string | undefined, Set<symbol>>>
  >();

  return <Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: Variables,
    watched?: Map<object, Set<symbol>>,
  ): JsonValue | undefined => {
    const transformedDocument = transformDocument(document);

    const getRequiredKeys = (
      node: FieldNode | OperationDefinitionNode,
      typename: string | undefined,
    ): Set<symbol> => {
      let byVariables = requiredKeysCache.get(node);
      if (byVariables == null) {
        byVariables = new WeakMap();
        requiredKeysCache.set(node, byVariables);
      }

      let byTypename = byVariables.get(variables);
      if (byTypename == null) {
        byTypename = new Map();
        byVariables.set(variables, byTypename);
      }

      const cached = byTypename.get(typename);
      if (cached != null) {
        return cached;
      }

      const requiredKeys = new Set<symbol>();

      const collect = (selectionSet: SelectionSetNode): void => {
        for (const selection of selectionSet.selections) {
          if (selection.kind === Kind.FIELD) {
            if (!isExcluded(selection, variables)) {
              const key = getFieldNameWithArguments(selection, variables);

              // `__typename` is never required: the spec guarantees it in
              // every response, but a nonconforming response omitting it must
              // not turn the entry into a permanent miss. (Same exclusion as
              // `trackField`, see watch.ts.)
              if (key !== TYPENAME_KEY) {
                requiredKeys.add(key);
              }
            }
          } else if (selection.kind === Kind.INLINE_FRAGMENT) {
            const typeCondition = selection.typeCondition?.name.value;

            if (
              !isExcluded(selection, variables) &&
              (typeCondition == null ||
                typename == null ||
                deps.isTypeCompatible(typename, typeCondition))
            ) {
              collect(selection.selectionSet);
            }
          }
        }
      };

      if (node.selectionSet != null) {
        collect(node.selectionSet);
      }

      byTypename.set(typename, requiredKeys);
      return requiredKeys;
    };

    const getEntryTypename = (entry: CacheEntry): string | undefined => {
      const typename = entry[TYPENAME_KEY];
      return typeof typename === "string" ? typename : undefined;
    };

    const getFromCache = (
      cacheKey: symbol,
      node: FieldNode | OperationDefinitionNode,
    ): CacheEntry | typeof MISS => {
      const entry = deps.get(cacheKey);

      if (entry === MISS) {
        return MISS;
      }

      return containsAll(
        entry[REQUESTED_KEYS],
        getRequiredKeys(node, getEntryTypename(entry)),
      )
        ? entry
        : MISS;
    };

    const getFromCacheOrReturnValue = (
      valueOrKey: unknown,
      node: FieldNode | OperationDefinitionNode,
    ): unknown => {
      if (typeof valueOrKey === "symbol") {
        return getFromCache(valueOrKey, node);
      }

      if (isCacheEntry(valueOrKey)) {
        return containsAll(
          valueOrKey[REQUESTED_KEYS],
          getRequiredKeys(node, getEntryTypename(valueOrKey)),
        )
          ? valueOrKey
          : MISS;
      }

      return valueOrKey;
    };

    // Builds a clean, string-keyed result directly. `source` is read-only:
    // a cache entry (field values under argument-qualified symbol keys) or a
    // cached raw value. Values go into `result`, so there is no separate pass
    // to strip the internal symbol keys afterward. A field shared across
    // selections (e.g. between the base selection and an inline fragment) is
    // re-read from `source` each time, and its sub-selections merge into the
    // result object the first read created.
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

      if (watched != null) {
        // Record that this read depends on `source`'s value for this field,
        // whether it is present or still missing: a write storing under the
        // same key (always `fieldNameWithArguments`, see write.ts) must wake
        // up whoever reads this, and a miss is resolved by exactly such a
        // write. (`trackField` itself excludes `__typename`, see watch.ts.)
        trackField(watched, source, fieldNameWithArguments);
      }

      const cacheHasKey =
        hasOwn(source, originalFieldName) ||
        hasOwn(source, fieldNameWithArguments);

      if (!cacheHasKey) {
        // A field excluded by `@include(if: false)` / `@skip(if: true)` is
        // absent from the response, so its absence from the cache is not a
        // miss, skip it. Same for `__typename` (see `getRequiredKeys`). Any
        // other missing field is a genuine miss.
        return (
          fieldNameWithArguments === TYPENAME_KEY ||
          isExcluded(fieldNode, variables)
        );
      }

      const rawValue = hasOwn(source, originalFieldName)
        ? source[originalFieldName]
        : source[fieldNameWithArguments];

      if (rawValue == null) {
        // Preserve a cached `null`; drop `undefined` (matches JSON output).
        if (rawValue === null) {
          result[originalFieldName] = null;
        }
        return true;
      }

      // Resolve a single cached value or key: pull it from the cache, then
      // recurse into any nested selection set. Returns MISS on a cache miss.
      // `existing` is what an earlier selection already resolved for this
      // field: sub-selections merge into it instead of replacing it, so the
      // fields it already holds are preserved.
      const resolve = (valueOrKey: unknown, existing: unknown): unknown => {
        const value = getFromCacheOrReturnValue(valueOrKey, fieldNode);

        if (value === MISS) {
          return MISS;
        }

        if (isRecord(value) && fieldNode.selectionSet != null) {
          // oxlint-disable-next-line no-use-before-define
          return traverse(
            fieldNode.selectionSet,
            value,
            isRecord(existing) ? existing : {},
          );
        }

        // Leaf values (custom scalar objects and arrays) are stored by
        // reference at write time; return a copy so a caller mutating the
        // result can't corrupt the cache.
        return typeof value === "object" && value != null
          ? deepCopy(value)
          : value;
      };

      // Both reads of a shared field use the same `source` key, so on a
      // second read the array length and item order line up with `existing`.
      const existingValue = result[originalFieldName];

      if (Array.isArray(rawValue)) {
        const existingItems = Array.isArray(existingValue)
          ? existingValue
          : undefined;
        const items: unknown[] = [];

        for (let index = 0; index < rawValue.length; index++) {
          const value = resolve(rawValue[index], existingItems?.[index]);

          if (value === MISS) {
            return false;
          }

          items.push(value == null ? null : value);
        }

        result[originalFieldName] = items;
        return true;
      }

      const value = resolve(rawValue, existingValue);

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
      // A fragment excluded by `@include(if: false)` / `@skip(if: true)`
      // contributes nothing to the response, so its fields' absence from the
      // cache is not a miss.
      if (isExcluded(inlineFragmentNode, variables)) {
        return true;
      }

      const typeCondition = inlineFragmentNode.typeCondition?.name.value;
      // `__typename` is selected first in every selection set (see
      // transform.ts), so by the time we reach an inline fragment it has
      // already been written to `result`.
      const dataTypename = getTypename(result);

      if (typeCondition != null && dataTypename != null) {
        if (deps.isTypeCompatible(dataTypename, typeCondition)) {
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
                      deps.isTypeCompatible(dataTypename, nestedTypeCondition)
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
      if (source == null) {
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
      result: Record<PropertyKey, unknown> = {},
    ): unknown => {
      if (!applySelections(selections, source, result)) {
        return MISS;
      }

      // Carry over the connection reference (a string key, not a queried
      // field) so consumers like `useForwardPagination`/`useBackwardPagination`
      // and `updateConnection` can locate the registered connection.
      if (hasOwn(source, CONNECTION_REF)) {
        result[CONNECTION_REF] = source[CONNECTION_REF];
      }

      return result;
    };

    const operation = getOperationDefinition(transformedDocument);

    if (operation == null) {
      return undefined;
    }

    const cacheKey = getCacheKeyFromOperationNode(operation);

    if (cacheKey == null) {
      return undefined;
    }

    const cache = getFromCache(cacheKey, operation);

    if (cache === MISS) {
      return undefined;
    }

    const traversed = traverse(operation.selectionSet, cache);

    if (traversed === MISS) {
      return undefined;
    }

    // `traverse` builds this from cache entries whose field values are
    // untyped at the storage level, but it only ever writes plain scalars,
    // plain objects, and plain arrays into `result`, never a raw cache entry
    // or a symbol key. So the tree is already `JsonValue`-shaped.
    const value = traversed as JsonValue;

    // Return a stable reference when possible: per document, a WeakMap keyed
    // by serialized variables holds the last result returned for that key. If
    // the new value deeply equals it, hand back the old reference instead so
    // consumers relying on referential equality (e.g. React) don't re-render.
    const serializedVariables = serializeVariables(variables);
    const documentCache = STABILITY_CACHE.get(transformedDocument);
    const previous = documentCache?.get(serializedVariables);

    if (previous != null && deepEqual(value, previous)) {
      return previous;
    }

    const nextDocumentCache = documentCache ?? new Map<string, JsonValue>();
    nextDocumentCache.set(serializedVariables, value);
    STABILITY_CACHE.set(transformedDocument, nextDocumentCache);
    return value;
  };
};
