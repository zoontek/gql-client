import {
  Kind,
  OperationTypeNode,
  type DirectiveNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { AnyVariables } from "../types";

/**
 * Gets the field name in the response payload from its AST definition
 *
 * @param fieldNode
 * @returns field name
 */
export const getFieldName = (fieldNode: FieldNode): string => {
  return fieldNode.alias ? fieldNode.alias.value : fieldNode.name.value;
};

/**
 * Resolves and serializes a GraphQL value
 *
 * @param valueNode: ValueNode
 * @param variables: Record<string, any>
 * @returns Record<string, any>
 */
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

// Arguments are pure over `(fieldNode, variables)` and recomputed on every
// read (via `getFieldNameWithArguments`) and write (connection registration).
// Memoize on the stable AST node and variables reference. The result is treated
// as read-only by callers, so sharing it is safe.
const argumentsCache = new WeakMap<
  FieldNode,
  WeakMap<AnyVariables, AnyVariables>
>();

/**
 * Returns a record representation of the arguments passed to a given field
 *
 * @param fieldNode
 * @param variables
 * @returns Record<string, any>
 */
export const extractArguments = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): AnyVariables => {
  let byVariables = argumentsCache.get(fieldNode);
  if (byVariables === undefined) {
    byVariables = new WeakMap<AnyVariables, AnyVariables>();
    argumentsCache.set(fieldNode, byVariables);
  }

  const cached = byVariables.get(variables);
  if (cached !== undefined) {
    return cached;
  }

  const args = fieldNode.arguments ?? [];
  const extracted = Object.fromEntries(
    args.map(({ name: { value: name }, value }) => [
      name,
      extractValue(value, variables),
    ]),
  );

  byVariables.set(variables, extracted);
  return extracted;
};

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
 * @param fieldNode
 * @param variables The variables of the GraphQL operation
 * @returns symbol
 */
// Field symbols are pure over `(fieldNode, variables)` but recomputed per field
// on every cache read/write (Symbol.for lookup + extractArguments + JSON
// serialization). The AST nodes are stable (documents are transformed once and
// cached) and the variables reference is stable across re-renders, so memoize
// on both: a plain symbol for argument-less fields, and a per-variables symbol
// otherwise.
const fieldSymbolCache = new WeakMap<FieldNode, symbol>();
const fieldSymbolWithVariablesCache = new WeakMap<
  FieldNode,
  WeakMap<AnyVariables, symbol>
>();

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

  let byVariables = fieldSymbolWithVariablesCache.get(fieldNode);
  if (byVariables === undefined) {
    byVariables = new WeakMap<AnyVariables, symbol>();
    fieldSymbolWithVariablesCache.set(fieldNode, byVariables);
  }

  let symbol = byVariables.get(variables);
  if (symbol === undefined) {
    const fieldName = getFieldName(fieldNode);
    const args = extractArguments(fieldNode, variables);
    symbol =
      Object.keys(args).length === 0
        ? Symbol.for(fieldName)
        : Symbol.for(`${fieldName}(${JSON.stringify(args)})`);
    byVariables.set(variables, symbol);
  }
  return symbol;
};

/**
 * Returns a Set<string> with all keys selected within the direct selection sets
 * of a given `FieldNode` or `OperationDefinitionNode`.
 *
 * { user { id, firstName, lastName } }
 * => Set{"id", "firstName", "lastName"}
 *
 * @param fieldNode FieldNode | OperationDefinitionNode
 * @returns selectedKeys Set<string>
 */
// Same memoization rationale as `getFieldNameWithArguments`: this runs per
// field (and per array element) on every read, rebuilding a Set each time. The
// returned Set is treated as read-only by callers, so it is safe to share.
const selectedKeysCache = new WeakMap<
  FieldNode | OperationDefinitionNode,
  WeakMap<AnyVariables, Set<symbol>>
>();

export const getSelectedKeys = (
  fieldNode: FieldNode | OperationDefinitionNode,
  variables: AnyVariables,
): Set<symbol> => {
  let byVariables = selectedKeysCache.get(fieldNode);
  if (byVariables === undefined) {
    byVariables = new WeakMap<AnyVariables, Set<symbol>>();
    selectedKeysCache.set(fieldNode, byVariables);
  }

  let selectedKeys = byVariables.get(variables);
  if (selectedKeys !== undefined) {
    return selectedKeys;
  }

  selectedKeys = new Set<symbol>();
  const computed = selectedKeys;

  const traverse = (selections: SelectionSetNode): void => {
    // We only need to care about FieldNode & InlineFragment node
    // as we inline all fragments in the query
    selections.selections.forEach((selection) => {
      if (selection.kind === Kind.FIELD) {
        const fieldNameWithArguments = getFieldNameWithArguments(
          selection,
          variables,
        );
        computed.add(fieldNameWithArguments);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        traverse(selection.selectionSet);
      }
    });
  };

  if (fieldNode.selectionSet) {
    traverse(fieldNode.selectionSet);
  }

  byVariables.set(variables, selectedKeys);
  return selectedKeys;
};

export const getOperationName = (
  document: TypedDocumentNode,
): string | undefined => {
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      return definition.name?.value;
    }
  }
};

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

export const getCacheKeyFromOperationNode = (
  operationNode: OperationDefinitionNode,
): symbol | undefined => {
  switch (operationNode.operation) {
    case OperationTypeNode.QUERY:
      return Symbol.for("Query");
    case OperationTypeNode.SUBSCRIPTION:
      return Symbol.for("Subscription");
    default:
      return undefined;
  }
};

export const getCacheEntryKey = (json: unknown): symbol | undefined => {
  if (typeof json === "object" && json != null) {
    if ("__typename" in json && typeof json.__typename === "string") {
      const typename = json.__typename;

      if (
        typename === "Mutation" ||
        typename === "Query" ||
        typename === "Subscription"
      ) {
        return Symbol.for(typename);
      }

      if ("id" in json && typeof json.id === "string") {
        return Symbol.for(`${typename}<${json.id}>`);
      }
    }
  }
  return undefined;
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
