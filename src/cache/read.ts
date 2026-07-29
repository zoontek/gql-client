import {
  Kind,
  type FieldNode,
  type InlineFragmentNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  getFieldName,
  getFieldNameWithArguments,
  getOperationDefinition,
  getSelectedKeys,
  getTypename,
  isExcluded,
} from "../graphql/ast";
import type { AnyVariables, JsonValue } from "../types";
import {
  containsAll,
  deepEqual,
  hasOwn,
  isRecord,
  serializeVariables,
} from "../utils";
import {
  CONNECTION_REF,
  getCacheKeyFromOperationNode,
  REQUESTED_KEYS,
} from "./keys";
import { MISS } from "./types";

const STABILITY_CACHE = new WeakMap<
  TypedDocumentNode,
  Map<string, JsonValue>
>();

export type ReadDeps = {
  // Raw map lookup, defaulting to MISS. Shared with the write/connection-update
  // paths, so it lives on the class rather than being duplicated here.
  get: (cacheKey: symbol) => unknown;
  isTypeCompatible: (typename: string, typeCondition: string) => boolean;
};

export const createReadOperation = (
  deps: ReadDeps,
): ((
  document: TypedDocumentNode,
  variables: AnyVariables,
) => JsonValue | undefined) => {
  const getFromCache = (
    cacheKey: symbol,
    requestedKeys: Set<symbol>,
  ): unknown => {
    const entry = deps.get(cacheKey);

    // `entry` is either a record cache entry, a scalar, or the MISS sentinel
    // (a symbol, so it falls through to the return below).
    if (isRecord(entry)) {
      return containsAll(entry[REQUESTED_KEYS] as Set<symbol>, requestedKeys)
        ? entry
        : MISS;
    }

    return entry;
  };

  const getFromCacheOrReturnValue = (
    valueOrKey: unknown,
    selectedKeys: Set<symbol>,
  ): unknown => {
    if (typeof valueOrKey === "symbol") {
      const entry = getFromCache(valueOrKey, selectedKeys);
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
  };

  return (
    document: TypedDocumentNode,
    variables: AnyVariables,
  ): JsonValue | undefined => {
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
        const value = getFromCacheOrReturnValue(valueOrKey, selectedKeys);

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

    const operation = getOperationDefinition(document);

    if (operation === undefined) {
      return undefined;
    }

    const cacheKey = getCacheKeyFromOperationNode(operation);

    if (cacheKey === undefined) {
      return undefined;
    }

    const cache = getFromCache(cacheKey, getSelectedKeys(operation, variables));

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
  };
};
