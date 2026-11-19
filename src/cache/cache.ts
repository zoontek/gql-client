import {
  Kind,
  type FieldNode,
  type InlineFragmentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import {
  extractArguments,
  getFieldKey,
  getOperationDefinition,
  getResponseKey,
  isExcluded,
  memoizeByNodeAndVariables,
} from "../graphql/ast";
import { transformDocument } from "../graphql/transform";
import type { AnyVariables, Connection, Edge, JsonValue } from "../types";
import {
  containsAll,
  deepCopy,
  filterMap,
  getOrInsert,
  hasOwn,
  isRecord,
} from "../utils";
import {
  CONNECTION_REF,
  CURSOR_KEY,
  EDGES_KEY,
  getEntryKey,
  getIdFromEntryKey,
  getRootEntryKey,
  MISS,
  NODE_KEY,
  REQUESTED_KEYS,
  setConnectionRef,
  TYPENAME_KEY,
} from "./keys";
import { decodeEntry, encodeEntry, type SerializedCache } from "./serialize";
import {
  createCacheEntry,
  isCachedEdge,
  isCacheEntry,
  type CacheEntry,
  type ConnectionInfo,
  type ConnectionRef,
  type SchemaConfig,
} from "./types";
import { trackField } from "./watch";

type ResultCache = WeakMap<TypedDocumentNode, WeakMap<AnyVariables, JsonValue>>;

// Structural sharing. Each subtree of `next` that deeply equals its `prev`
// counterpart is replaced by it, and `prev` is returned if all is equal. React
// then re-renders only what changed. Mutates `next`.
const shareEqualSubtrees = (prev: unknown, next: unknown): unknown => {
  if (Object.is(prev, next)) {
    return prev;
  }

  if (Array.isArray(prev) && Array.isArray(next)) {
    let equal = prev.length === next.length;

    for (let index = 0; index < next.length; index++) {
      const item = shareEqualSubtrees(prev[index], next[index]);
      next[index] = item;
      equal = equal && item === prev[index];
    }

    return equal ? prev : next;
  }

  if (isRecord(prev) && isRecord(next)) {
    const keys = Object.keys(next);

    // The connection ref is non-enumerable, so it is compared on its own.
    let equal =
      keys.length === Object.keys(prev).length &&
      prev[CONNECTION_REF] === next[CONNECTION_REF];

    for (const key of keys) {
      const value = shareEqualSubtrees(prev[key], next[key]);
      next[key] = value;
      equal = equal && hasOwn(prev, key) && value === prev[key];
    }

    return equal ? prev : next;
  }

  return next;
};

type ReadContext = {
  variables: AnyVariables;
  watched: Map<object, Set<symbol>> | undefined;
};

type ScopedSelectionSet = {
  selectionSet: SelectionSetNode;
  variables: AnyVariables;
};

const getEntryTypename = (entry: CacheEntry): string | undefined => {
  const typename = entry[TYPENAME_KEY];
  return typeof typename === "string" ? typename : undefined;
};

export type EdgeList<Node> = (Edge<Node> | null | undefined)[];

export type ConnectionUpdateConfig<Node> =
  | { prepend: EdgeList<Node> }
  | { append: EdgeList<Node> }
  | { remove: (string | number)[] };

export class ClientCache {
  private connections = new WeakMap<ConnectionRef, ConnectionInfo>();
  private entries = new Map<symbol, CacheEntry>();
  private interfaceToTypes: Record<string, Set<string>>;
  private mountedDocuments = new Map<TypedDocumentNode, number>();
  private resultCache: ResultCache = new WeakMap();

  private requiredKeysCache = new WeakMap<
    FieldNode | OperationDefinitionNode,
    WeakMap<AnyVariables, Map<string | undefined, Set<symbol>>>
  >();

  public constructor(schemaConfig: SchemaConfig) {
    this.interfaceToTypes = Object.fromEntries(
      Object.entries(schemaConfig.interfaceToTypes).map(([key, value]) => {
        return [key, new Set<string>(value)];
      }),
    );
  }

  public purge(): void {
    this.connections = new WeakMap();
    this.entries = new Map();
    this.resultCache = new WeakMap();
  }

  public extract(): SerializedCache {
    return {
      entries: [...this.entries].map(([key, entry]) => {
        return [key.description ?? "", encodeEntry(entry)];
      }),
    };
  }

  public restore(data: SerializedCache): void {
    const cache = new Map(
      data.entries.map(([key, entry]) => [Symbol.for(key), decodeEntry(entry)]),
    );

    this.purge();
    this.entries = cache;
  }

  public dump(): Map<symbol, CacheEntry> {
    return this.entries;
  }

  public retainDocument(document: TypedDocumentNode): () => void {
    this.mountedDocuments.set(
      document,
      (this.mountedDocuments.get(document) ?? 0) + 1,
    );

    return () => {
      const count = (this.mountedDocuments.get(document) ?? 0) - 1;

      if (count > 0) {
        this.mountedDocuments.set(document, count);
      } else {
        this.mountedDocuments.delete(document);
      }
    };
  }

  public getConnectionInfo(ref: unknown): ConnectionInfo | undefined {
    return typeof ref === "object" && ref != null
      ? this.connections.get(ref)
      : undefined;
  }

  private fragmentApplies(
    fragment: InlineFragmentNode,
    typename: unknown,
    variables: AnyVariables,
  ): boolean {
    const typeCondition = fragment.typeCondition?.name.value;

    const typeMatches =
      typeCondition == null ||
      typeof typename !== "string" ||
      typename === typeCondition ||
      this.interfaceToTypes[typeCondition]?.has(typename) === true;

    return typeMatches && !isExcluded(fragment, variables);
  }

  private getOrCreateEntry(entryKey: symbol): CacheEntry {
    return getOrInsert(this.entries, entryKey, createCacheEntry);
  }

  private linkEntry(
    json: unknown,
    existing: unknown,
  ): { entry: CacheEntry; stored: symbol | CacheEntry } {
    const entryKey = getEntryKey(json);

    const entry =
      entryKey != null
        ? this.getOrCreateEntry(entryKey)
        : isCacheEntry(existing)
          ? existing
          : createCacheEntry();

    return { entry, stored: entryKey ?? entry };
  }

  // Field keys that an entry with this `typename` must have to be read with
  // `node`. Fields excluded by @include/@skip, and fields of inline fragments
  // that do not match `typename`, are not required, because the write path
  // skips them too.
  private getRequiredKeys(
    node: FieldNode | OperationDefinitionNode,
    typename: string | undefined,
    variables: AnyVariables,
  ): Set<symbol> {
    const byTypename = memoizeByNodeAndVariables(
      this.requiredKeysCache,
      node,
      variables,
      () => new Map<string | undefined, Set<symbol>>(),
    );

    const cached = byTypename.get(typename);

    if (cached != null) {
      return cached;
    }

    const requiredKeys = new Set<symbol>();

    const collect = (selectionSet: SelectionSetNode): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (!isExcluded(selection, variables)) {
            const key = getFieldKey(selection, variables);

            // `__typename` is never required, so a response without it does not
            // make the entry a permanent miss.
            if (key !== TYPENAME_KEY) {
              requiredKeys.add(key);
            }
          }
        } else if (
          selection.kind === Kind.INLINE_FRAGMENT &&
          this.fragmentApplies(selection, typename, variables)
        ) {
          collect(selection.selectionSet);
        }
      }
    };

    if (node.selectionSet != null) {
      collect(node.selectionSet);
    }

    byTypename.set(typename, requiredKeys);
    return requiredKeys;
  }

  private resolveEntry(
    valueOrKey: unknown,
    node: FieldNode | OperationDefinitionNode,
    variables: AnyVariables,
  ): unknown {
    const value =
      typeof valueOrKey === "symbol"
        ? (this.entries.get(valueOrKey) ?? MISS)
        : valueOrKey;

    if (!isCacheEntry(value)) {
      return value;
    }

    const isIncomplete = !containsAll(
      value[REQUESTED_KEYS],
      this.getRequiredKeys(node, getEntryTypename(value), variables),
    );

    return isIncomplete ? MISS : value;
  }

  private resolveValue(
    context: ReadContext,
    fieldNode: FieldNode,
    valueOrKey: unknown,
    existing: unknown,
  ): unknown {
    const value = this.resolveEntry(valueOrKey, fieldNode, context.variables);

    if (value === MISS) {
      return MISS;
    }

    if (isRecord(value) && fieldNode.selectionSet != null) {
      return this.readSelectionSet(
        context,
        fieldNode.selectionSet,
        value,
        isRecord(existing) ? existing : {},
      );
    }

    // A copy stops a caller from changing the cache through custom scalar
    // objects and scalar lists.
    return deepCopy(value);
  }

  // Lists can be nested, for example `[[Cell]]`.
  private readList(
    context: ReadContext,
    fieldNode: FieldNode,
    list: unknown[],
    existing: unknown,
  ): unknown {
    const existingItems = Array.isArray(existing) ? existing : undefined;
    const items: unknown[] = [];

    for (let index = 0; index < list.length; index++) {
      const item = list[index];

      const value = Array.isArray(item)
        ? this.readList(context, fieldNode, item, existingItems?.[index])
        : this.resolveValue(context, fieldNode, item, existingItems?.[index]);

      if (value === MISS) {
        return MISS;
      }

      items.push(value == null ? null : value);
    }

    return items;
  }

  private readField(
    context: ReadContext,
    fieldNode: FieldNode,
    source: Record<PropertyKey, unknown>,
    result: Record<PropertyKey, unknown>,
  ): boolean {
    const { variables, watched } = context;
    const responseKey = getResponseKey(fieldNode);
    const fieldKey = getFieldKey(fieldNode, variables);

    // Tracked also when the field is missing, because the write that adds it
    // must notify this reader.
    trackField(watched, source, fieldKey);

    if (!hasOwn(source, fieldKey)) {
      // A field excluded by @include/@skip is not in the response, so its
      // absence is not a miss. The same applies to `__typename`.
      return fieldKey === TYPENAME_KEY || isExcluded(fieldNode, variables);
    }

    const rawValue = source[fieldKey];

    // Keeps a cached `null` and drops `undefined`, as JSON does.
    if (rawValue == null) {
      if (rawValue === null) {
        result[responseKey] = null;
      }
      return true;
    }

    // Another selection of this field (for example in an inline fragment) can
    // already be in `result`. Sub-selections merge into that value.
    const existingValue = result[responseKey];

    const value = Array.isArray(rawValue)
      ? this.readList(context, fieldNode, rawValue, existingValue)
      : this.resolveValue(context, fieldNode, rawValue, existingValue);

    if (value === MISS) {
      return false;
    }

    result[responseKey] = value;
    return true;
  }

  // `__typename` is the first selection (see transform.ts), so
  // `result.__typename` is already set when an inline fragment is read.
  private readInlineFragment(
    context: ReadContext,
    inlineFragmentNode: InlineFragmentNode,
    source: Record<PropertyKey, unknown>,
    result: Record<PropertyKey, unknown>,
  ): boolean {
    return (
      !this.fragmentApplies(
        inlineFragmentNode,
        result.__typename,
        context.variables,
      ) ||
      this.readSelections(
        context,
        inlineFragmentNode.selectionSet,
        source,
        result,
      )
    );
  }

  private readSelections(
    context: ReadContext,
    selectionSet: SelectionSetNode,
    source: Record<PropertyKey, unknown>,
    result: Record<PropertyKey, unknown>,
  ): boolean {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (!this.readField(context, selection, source, result)) {
          return false;
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (!this.readInlineFragment(context, selection, source, result)) {
          return false;
        }
      } else {
        return false;
      }
    }

    return true;
  }

  private readSelectionSet(
    context: ReadContext,
    selections: SelectionSetNode,
    source: Record<PropertyKey, unknown>,
    result: Record<PropertyKey, unknown> = {},
  ): unknown {
    if (!this.readSelections(context, selections, source, result)) {
      return MISS;
    }

    if (hasOwn(source, CONNECTION_REF)) {
      setConnectionRef(result, source[CONNECTION_REF]);
    }

    return result;
  }

  public readOperation<Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: Variables,
    watched?: Map<object, Set<symbol>>,
  ): JsonValue | undefined {
    let transformedDocument: TypedDocumentNode;

    try {
      transformedDocument = transformDocument(document);
    } catch {
      // A broken document (for example with a missing fragment) is a miss. The
      // request then fails with a ClientError.
      return undefined;
    }

    const operation = getOperationDefinition(transformedDocument);
    const entryKey = operation != null ? getRootEntryKey(operation) : undefined;

    if (operation == null || entryKey == null) {
      return undefined;
    }

    const root = this.resolveEntry(entryKey, operation, variables);

    if (!isRecord(root)) {
      return undefined;
    }

    const traversed = this.readSelectionSet(
      { variables, watched },
      operation.selectionSet,
      root,
    );

    if (traversed === MISS) {
      return undefined;
    }

    // Keeps the last result per document and variables, for structural sharing.
    const documentCache = getOrInsert(
      this.resultCache,
      transformedDocument,
      () => new WeakMap<AnyVariables, JsonValue>(),
    );

    const shared = shareEqualSubtrees(
      documentCache.get(variables),
      traversed,
    ) as JsonValue;

    documentCache.set(variables, shared);
    return shared;
  }

  public writeOperation(
    document: TypedDocumentNode,
    response: JsonValue,
    variables: AnyVariables,
    touched?: Map<object, Set<symbol>>,
  ): void {
    const operation = getOperationDefinition(document);

    if (operation == null || !isRecord(response)) {
      return;
    }

    const entryKey = getRootEntryKey(operation);

    // Response path of the current field, as a stack. Copied when a connection
    // is registered.
    const path: PropertyKey[] = [];

    // One copy per write. Connection infos that kept the caller's variables
    // object would keep the read results keyed by it alive.
    let variablesCopy: AnyVariables | undefined;

    const registerConnection = (entry: CacheEntry, field: FieldNode): void => {
      let info = this.getConnectionInfo(entry[CONNECTION_REF]);

      if (info == null) {
        info = {
          entry,
          fieldArguments: extractArguments(field, variables),
          readers: new Map(),
        };

        const ref: ConnectionRef = {};
        this.connections.set(ref, info);
        entry[CONNECTION_REF] = ref;
      }

      // A mutation is never read back, so it is not a reader.
      if (entryKey != null) {
        info.readers.set(field, {
          document,
          variables: (variablesCopy ??= { ...variables }),
          path: [...path],
        });
      }
    };

    // Lists can be nested, for example `[[Cell]]`. Inline entries at the same
    // index are reused, so they are updated in place.
    const writeList = (
      selectionSet: SelectionSetNode,
      list: unknown[],
      existing: unknown,
    ): unknown[] => {
      const existingItems = Array.isArray(existing) ? existing : [];

      return list.map((item, index) => {
        if (!Array.isArray(item) && !isRecord(item)) {
          return item;
        }

        path.push(index);
        let stored: unknown;

        if (Array.isArray(item)) {
          stored = writeList(selectionSet, item, existingItems[index]);
        } else {
          const linked = this.linkEntry(item, existingItems[index]);
          stored = linked.stored;
          // oxlint-disable-next-line no-use-before-define
          writeSelectionSet(selectionSet, item, linked.entry);
        }

        path.pop();
        return stored;
      });
    };

    const writeField = (
      field: FieldNode,
      parentJson: Record<PropertyKey, unknown>,
      parentEntry: CacheEntry,
    ): void => {
      const responseKey = getResponseKey(field);

      // A field that is not in the response (excluded by @include/@skip, or not
      // sent) is not recorded. Else a later read would treat it as cached.
      if (!hasOwn(parentJson, responseKey)) {
        return;
      }

      const fieldKey = getFieldKey(field, variables);
      const fieldValue = parentJson[responseKey];

      parentEntry[REQUESTED_KEYS].add(fieldKey);
      trackField(touched, parentEntry, fieldKey);

      const subSelectionSet = field.selectionSet;

      if (subSelectionSet == null || fieldValue == null) {
        parentEntry[fieldKey] = deepCopy(fieldValue);
        return;
      }

      if (Array.isArray(fieldValue)) {
        path.push(responseKey);

        parentEntry[fieldKey] = writeList(
          subSelectionSet,
          fieldValue,
          parentEntry[fieldKey],
        );

        path.pop();
        return;
      }

      if (!isRecord(fieldValue)) {
        return;
      }

      const { entry, stored } = this.linkEntry(
        fieldValue,
        parentEntry[fieldKey],
      );

      parentEntry[fieldKey] = stored;
      path.push(responseKey);

      // A Relay connection, found by its typename. It gets a ref, so
      // usePagination and updateConnection can find it.
      if (
        typeof fieldValue.__typename === "string" &&
        fieldValue.__typename.endsWith("Connection")
      ) {
        registerConnection(entry, field);
      }

      // oxlint-disable-next-line no-use-before-define
      writeSelectionSet(subSelectionSet, fieldValue, entry);
      path.pop();
    };

    const writeSelectionSet = (
      selectionSet: SelectionSetNode,
      json: Record<PropertyKey, unknown>,
      entry: CacheEntry,
    ): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          writeField(selection, json, entry);
        } else if (
          selection.kind === Kind.INLINE_FRAGMENT &&
          this.fragmentApplies(selection, json.__typename, variables)
        ) {
          writeSelectionSet(selection.selectionSet, json, entry);
        }
      }
    };

    // A mutation root goes to a detached entry. Nested objects with an id still
    // go to the cache.
    const entry =
      entryKey != null ? this.getOrCreateEntry(entryKey) : createCacheEntry();

    writeSelectionSet(operation.selectionSet, response, entry);
  }

  // The `edges` selections of the mounted queries that wrote this connection,
  // with the inline fragments that match its type.
  private getEdgesSelectionSets(info: ConnectionInfo): ScopedSelectionSet[] {
    const typename = info.entry[TYPENAME_KEY];
    const selectionSets: ScopedSelectionSet[] = [];

    const collect = (
      selectionSet: SelectionSetNode,
      variables: AnyVariables,
    ): void => {
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (
            selection.selectionSet != null &&
            !isExcluded(selection, variables) &&
            getFieldKey(selection, variables) === EDGES_KEY
          ) {
            selectionSets.push({
              selectionSet: selection.selectionSet,
              variables,
            });
          }
        } else if (
          selection.kind === Kind.INLINE_FRAGMENT &&
          this.fragmentApplies(selection, typename, variables)
        ) {
          collect(selection.selectionSet, variables);
        }
      }
    };

    info.readers.forEach(({ document, variables }, field) => {
      // A query that is not mounted cannot miss now. If it mounts later and
      // misses, it fetches again.
      if (field.selectionSet != null && this.mountedDocuments.has(document)) {
        collect(field.selectionSet, variables);
      }
    });

    return selectionSets;
  }

  private createEdgeEntries<A>(
    edges: EdgeList<A>,
    info: ConnectionInfo,
  ): CacheEntry[] {
    const edgesSelectionSets = this.getEdgesSelectionSets(info);

    return filterMap(edges, (item) => {
      if (item == null) {
        return undefined;
      }

      const { node, __typename, cursor } = item;
      const key = getEntryKey(node);

      if (key == null || !this.entries.has(key)) {
        return undefined;
      }

      // A real cache entry, so `extract` serializes it. `cursor` is stored too.
      // Without it, a query that selects `edges { cursor }` reads this edge as
      // a miss.
      const edge = createCacheEntry();
      edge[REQUESTED_KEYS].add(NODE_KEY).add(CURSOR_KEY);

      if (typeof __typename === "string") {
        edge[TYPENAME_KEY] = __typename;
      }

      edge[NODE_KEY] = key;
      edge[CURSOR_KEY] = cursor ?? null;

      const readable = edgesSelectionSets.every(
        ({ selectionSet, variables }) =>
          this.readSelectionSet(
            { variables, watched: undefined },
            selectionSet,
            edge,
          ) !== MISS,
      );

      // An edge that a mounted query cannot fully read would make that query a
      // miss. This happens when the request that returned the node selected
      // fewer fields.
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
    update: ConnectionUpdateConfig<A>,
    touched?: Map<object, Set<symbol>>,
  ): void {
    if (connection == null || !(CONNECTION_REF in connection)) {
      return;
    }

    const info = this.getConnectionInfo(connection[CONNECTION_REF]);

    if (info == null) {
      return;
    }

    const { entry } = info;
    const cachedEdges = entry[EDGES_KEY];

    const currentEdges: unknown[] = Array.isArray(cachedEdges)
      ? cachedEdges
      : [];

    trackField(touched, entry, EDGES_KEY);

    if ("prepend" in update) {
      entry[EDGES_KEY] = [
        ...this.createEdgeEntries(update.prepend, info),
        ...currentEdges,
      ];
    } else if ("append" in update) {
      entry[EDGES_KEY] = [
        ...currentEdges,
        ...this.createEdgeEntries(update.append, info),
      ];
    } else {
      const nodeIds = new Set(update.remove.map(String));

      // Items that are not cached edges (a `null` edge, a node without an id)
      // stay.
      entry[EDGES_KEY] = currentEdges.filter((edge) => {
        if (!isCachedEdge(edge)) {
          return true;
        }

        const id = getIdFromEntryKey(edge[NODE_KEY]);
        return id == null || !nodeIds.has(id);
      });
    }
  }
}
