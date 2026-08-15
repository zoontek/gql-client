import {
  Kind,
  type FieldNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import {
  extractArguments,
  getFieldName,
  getFieldNameWithArguments,
  getOperationDefinition,
} from "../graphql/ast";
import type { AnyVariables, JsonValue } from "../types";
import { isRecord } from "../utils";
import {
  CONNECTION_REF,
  getCacheKeyFromOperationNode,
  REQUESTED_KEYS,
} from "./keys";
import {
  isCacheEntryArrayItem,
  type CacheEntry,
  type ConnectionInfo,
} from "./types";
import { trackField } from "./watch";

export type WriteDeps = {
  getOrCreateEntry: (cacheKey: symbol) => CacheEntry;
  linkCacheEntry: (
    json: unknown,
    existing: unknown,
  ) => { entry: CacheEntry; stored: symbol | CacheEntry };
  registerConnectionInfo: (info: ConnectionInfo) => number;
};

export const createWriteOperation = (
  deps: WriteDeps,
): ((
  document: TypedDocumentNode,
  response: JsonValue,
  variables: AnyVariables,
  touched?: Map<object, Set<symbol>>,
) => void) => {
  return (
    document: TypedDocumentNode,
    response: JsonValue,
    variables: AnyVariables,
    touched?: Map<object, Set<symbol>>,
  ): void => {
    const registerConnection = (
      cacheEntry: CacheEntry,
      pathInQuery: PropertyKey[],
      fieldVariables: AnyVariables,
    ): void => {
      if (cacheEntry[CONNECTION_REF] != null) {
        return;
      }
      const id = deps.registerConnectionInfo({
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

      if (touched !== undefined) {
        trackField(touched, parentCache, fieldNameWithArguments);
      }

      // Scalar with no selection, or a null/undefined value: store as is.
      const subSelectionSet = field.selectionSet;
      if (subSelectionSet === undefined || fieldValue == null) {
        parentCache[fieldNameWithArguments] = fieldValue;
        return;
      }
      // Array with a selection set: cache each item.
      if (Array.isArray(fieldValue)) {
        const existingArray = parentCache[fieldNameWithArguments];
        const arrayCache: (symbol | CacheEntry | null)[] =
          Array.isArray(existingArray) &&
          existingArray.every(isCacheEntryArrayItem)
            ? existingArray
            : Array(fieldValue.length);
        arrayCache.length = fieldValue.length;
        if (parentCache[fieldNameWithArguments] == undefined) {
          parentCache[fieldNameWithArguments] = arrayCache;
        }
        fieldValue.forEach((item, index) => {
          if (item == null) {
            arrayCache[index] = item;
            return;
          }
          const { entry: cacheObject, stored } = deps.linkCacheEntry(
            item,
            arrayCache[index],
          );
          arrayCache[index] = stored;

          // oxlint-disable-next-line no-use-before-define
          cacheSelectionSet(subSelectionSet, item, cacheObject, [
            ...path,
            originalFieldName,
            index,
          ]);
        });
        return;
      }
      // Object with a selection set: cache it.
      if (!isRecord(fieldValue)) {
        return;
      }
      const record = fieldValue;
      const { entry: cacheObject, stored } = deps.linkCacheEntry(
        record,
        parentCache[fieldNameWithArguments],
      );
      parentCache[fieldNameWithArguments] = stored;

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

    const operation = getOperationDefinition(document);

    if (operation === undefined || !isRecord(response)) {
      return;
    }

    // Root __typename can vary, but we can't guess it from the document alone
    const cacheKey =
      getCacheKeyFromOperationNode(operation) ?? Symbol.for("Mutation");

    const cacheEntry = deps.getOrCreateEntry(cacheKey);
    cacheSelectionSet(operation.selectionSet, response, cacheEntry, []);
  };
};
