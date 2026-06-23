import {
  Kind,
  OperationTypeNode,
  type DirectiveNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "@0no-co/graphql.web";
import { Option } from "@bloodyowl/boxed";
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
  const args = fieldNode.arguments ?? [];
  return Object.fromEntries(
    args.map(({ name: { value: name }, value }) => [
      name,
      extractValue(value, variables),
    ]),
  );
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
export const getFieldNameWithArguments = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): symbol => {
  const fieldName = getFieldName(fieldNode);
  const args = extractArguments(fieldNode, variables);
  if (Object.keys(args).length === 0) {
    return Symbol.for(fieldName);
  }
  return Symbol.for(`${fieldName}(${JSON.stringify(args)})`);
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
export const getSelectedKeys = (
  fieldNode: FieldNode | OperationDefinitionNode,
  variables: AnyVariables,
): Set<symbol> => {
  const selectedKeys = new Set<symbol>();

  const traverse = (selections: SelectionSetNode): void => {
    // We only need to care about FieldNode & InlineFragment node
    // as we inline all fragments in the query
    selections.selections.forEach((selection) => {
      if (selection.kind === Kind.FIELD) {
        const fieldNameWithArguments = getFieldNameWithArguments(
          selection,
          variables,
        );
        selectedKeys.add(fieldNameWithArguments);
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

  return fieldNode.directives.some(
    (directive: DirectiveNode) =>
      directive.name.value === "include" &&
      directive.arguments != null &&
      directive.arguments.some((arg) => {
        return (
          arg.name.value === "if" &&
          extractValue(arg.value, variables) === false
        );
      }),
  );
};

export const getCacheKeyFromOperationNode = (
  operationNode: OperationDefinitionNode,
): Option<symbol> => {
  switch (operationNode.operation) {
    case OperationTypeNode.QUERY:
      return Option.Some(Symbol.for("Query"));
    case OperationTypeNode.SUBSCRIPTION:
      return Option.Some(Symbol.for("Subscription"));
    default:
      return Option.None();
  }
};
