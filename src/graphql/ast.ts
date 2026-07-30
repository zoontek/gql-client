import {
  Kind,
  type DirectiveNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import type { AnyVariables } from "../types";

// Field name as it appears in the response payload (alias if present).
export const getFieldName = (fieldNode: FieldNode): string =>
  fieldNode.alias ? fieldNode.alias.value : fieldNode.name.value;

// Resolves a GraphQL AST value node to a plain JS value, inlining variables.
const extractValue = (
  valueNode: ValueNode,
  variables: AnyVariables,
): unknown => {
  switch (valueNode.kind) {
    case Kind.NULL:
      return null;
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return valueNode.value;
    case Kind.LIST:
      return valueNode.values.map((value) => extractValue(value, variables));
    case Kind.OBJECT:
      return Object.fromEntries(
        valueNode.fields.map(({ name: { value: name }, value }) => [
          name,
          extractValue(value, variables),
        ]),
      );
    case Kind.VARIABLE:
      return variables[valueNode.name.value];
    default:
      return null;
  }
};

// Two-level memoization keyed on the AST node (stable) and the variables
// reference (stable across re-renders). The inner WeakMap is created lazily,
// so a cache hit, the hot path, allocates nothing. Computed values are
// treated as read-only by callers, so sharing them is safe.
const memoizeByNodeAndVariables = <K extends object, V>(
  cache: WeakMap<K, WeakMap<AnyVariables, V>>,
  node: K,
  variables: AnyVariables,
  compute: (node: K, variables: AnyVariables) => V,
): V => {
  let byVariables = cache.get(node);
  if (byVariables === undefined) {
    byVariables = new WeakMap<AnyVariables, V>();
    cache.set(node, byVariables);
  }

  let value = byVariables.get(variables);
  if (value === undefined) {
    value = compute(node, variables);
    byVariables.set(variables, value);
  }
  return value;
};

// Arguments are pure over `(fieldNode, variables)` and recomputed on every read
// (via `getFieldNameWithArguments`) and write (connection registration).
const argumentsCache = new WeakMap<
  FieldNode,
  WeakMap<AnyVariables, AnyVariables>
>();

const computeArguments = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): AnyVariables =>
  Object.fromEntries(
    (fieldNode.arguments ?? []).map(({ name: { value: name }, value }) => [
      name,
      extractValue(value, variables),
    ]),
  );

// Record representation of the arguments passed to a given field.
export const extractArguments = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): AnyVariables =>
  memoizeByNodeAndVariables(
    argumentsCache,
    fieldNode,
    variables,
    computeArguments,
  );

/**
 * Serializes the field name and arguments as a symbol.
 *
 * { user {id} }
 * => Symbol(`user`)
 *
 * { user(id: "1") {id} }
 * => Symbol(`user({"id":"1"})`)
 *
 * { user(id: $id) {id} } with variables `{"id": "2"}`
 * => Symbol(`user({"id":"2"})`)
 *
 * @param fieldNode - The field to serialize.
 * @param variables - The operation's variables, used to resolve any
 * variable arguments.
 * @returns The field's symbol.
 */
// Field symbols are pure over `(fieldNode, variables)` but recomputed per
// field on every cache read/write (Symbol.for lookup, extractArguments, JSON
// serialization). Both the AST node and the variables reference are stable
// across renders, so memoize on both: a plain symbol for argument-less
// fields, a per-variables symbol otherwise.
const fieldSymbolCache = new WeakMap<FieldNode, symbol>();
const fieldSymbolWithVariablesCache = new WeakMap<
  FieldNode,
  WeakMap<AnyVariables, symbol>
>();

const computeFieldSymbol = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): symbol => {
  const fieldName = getFieldName(fieldNode);
  const args = extractArguments(fieldNode, variables);
  return Object.keys(args).length === 0
    ? Symbol.for(fieldName)
    : Symbol.for(`${fieldName}(${JSON.stringify(args)})`);
};

export const getFieldNameWithArguments = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): symbol => {
  const fieldArguments = fieldNode.arguments;

  if (fieldArguments == null || fieldArguments.length === 0) {
    let symbol = fieldSymbolCache.get(fieldNode);
    if (symbol === undefined) {
      symbol = Symbol.for(getFieldName(fieldNode));
      fieldSymbolCache.set(fieldNode, symbol);
    }
    return symbol;
  }

  return memoizeByNodeAndVariables(
    fieldSymbolWithVariablesCache,
    fieldNode,
    variables,
    computeFieldSymbol,
  );
};

/**
 * Returns the set of field symbols (see `getFieldNameWithArguments`) selected
 * within the direct selection set of a `FieldNode` or `OperationDefinitionNode`.
 *
 * { user { id, firstName, lastName } }
 * => Set{Symbol(`id`), Symbol(`firstName`), Symbol(`lastName`)}
 *
 * @param fieldNode - The node whose direct selection set to read.
 * @param variables - The operation's variables, used to resolve any
 * variable arguments.
 * @returns The selected field symbols.
 */
// Same memoization rationale as `getFieldNameWithArguments`: this runs per
// field (and per array element) on every read, rebuilding a Set each time. The
// returned Set is treated as read-only by callers, so it is safe to share.
const selectedKeysCache = new WeakMap<
  FieldNode | OperationDefinitionNode,
  WeakMap<AnyVariables, Set<symbol>>
>();

const computeSelectedKeys = (
  fieldNode: FieldNode | OperationDefinitionNode,
  variables: AnyVariables,
): Set<symbol> => {
  const selectedKeys = new Set<symbol>();

  const traverse = (selections: SelectionSetNode): void => {
    // Only FieldNode and InlineFragmentNode matter here: fragment spreads are
    // already inlined by transformDocument by the time this runs.
    selections.selections.forEach((selection) => {
      if (selection.kind === Kind.FIELD) {
        selectedKeys.add(getFieldNameWithArguments(selection, variables));
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        traverse(selection.selectionSet);
      }
    });
  };

  if (fieldNode.selectionSet) {
    traverse(fieldNode.selectionSet);
  }

  return selectedKeys;
};

export const getSelectedKeys = (
  fieldNode: FieldNode | OperationDefinitionNode,
  variables: AnyVariables,
): Set<symbol> =>
  memoizeByNodeAndVariables(
    selectedKeysCache,
    fieldNode,
    variables,
    computeSelectedKeys,
  );

export const getOperationDefinition = (
  document: TypedDocumentNode,
): OperationDefinitionNode | undefined => {
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      return definition;
    }
  }
};

export const getOperationName = (
  document: TypedDocumentNode,
): string | undefined => getOperationDefinition(document)?.name?.value;

export const isExcluded = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): boolean => {
  if (!Array.isArray(fieldNode.directives)) {
    return false;
  }

  return fieldNode.directives.some((directive: DirectiveNode) => {
    const name = directive.name.value;

    // A field is excluded from the response by `@include(if: false)` or
    // `@skip(if: true)`. Either keeps it out of the payload, so its absence
    // from the cache must not be treated as a miss.
    if (name !== "include" && name !== "skip") {
      return false;
    }

    if (directive.arguments == null) {
      return false;
    }

    const excludeWhen = name === "skip";

    return directive.arguments.some(
      (arg) =>
        arg.name.value === "if" &&
        extractValue(arg.value, variables) === excludeWhen,
    );
  });
};

export const getTypename = (json: unknown): string | undefined => {
  if (typeof json === "object" && json != null) {
    if (Array.isArray(json)) {
      return getTypename(json[0]);
    }
    if ("__typename" in json && typeof json.__typename === "string") {
      return json.__typename;
    }
  }
};
