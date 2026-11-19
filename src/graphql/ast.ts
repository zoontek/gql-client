import {
  Kind,
  type DirectiveNode,
  type FieldNode,
  type InlineFragmentNode,
  type OperationDefinitionNode,
  type ValueNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import type { AnyVariables } from "../types";
import { getOrInsert, stableStringify } from "../utils";

export const getResponseKey = (fieldNode: FieldNode): string =>
  fieldNode.alias != null ? fieldNode.alias.value : fieldNode.name.value;

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
        valueNode.fields.map(({ name, value }) => [
          name.value,
          extractValue(value, variables),
        ]),
      );
    case Kind.VARIABLE:
      return variables[valueNode.name.value];
    default:
      return null;
  }
};

export const memoizeByNodeAndVariables = <K extends object, V>(
  cache: WeakMap<K, WeakMap<AnyVariables, V>>,
  node: K,
  variables: AnyVariables,
  compute: (node: K, variables: AnyVariables) => V,
): V => {
  const byVariables = getOrInsert(
    cache,
    node,
    () => new WeakMap<AnyVariables, V>(),
  );
  let value = byVariables.get(variables);

  if (value === undefined) {
    value = compute(node, variables);
    byVariables.set(variables, value);
  }

  return value;
};

const argumentsCache = new WeakMap<
  FieldNode,
  WeakMap<AnyVariables, AnyVariables>
>();

const computeArguments = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): AnyVariables =>
  Object.fromEntries(
    (fieldNode.arguments ?? []).map(({ name, value }) => [
      name.value,
      extractValue(value, variables),
    ]),
  );

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

const plainFieldKeyCache = new WeakMap<FieldNode, symbol>();

const fieldKeyCache = new WeakMap<FieldNode, WeakMap<AnyVariables, symbol>>();

const computePlainFieldKey = (fieldNode: FieldNode): symbol =>
  Symbol.for(fieldNode.name.value);

const computeFieldKey = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): symbol => {
  const fieldName = fieldNode.name.value;
  const args = extractArguments(fieldNode, variables);
  return Object.keys(args).length === 0
    ? Symbol.for(fieldName)
    : Symbol.for(`${fieldName}(${stableStringify(args)})`);
};

// Cache key of a field: its name and arguments, without the alias. With `{ id:
// "2" }`, `user(id: $id)` gives `user({"id":"2"})`.
export const getFieldKey = (
  fieldNode: FieldNode,
  variables: AnyVariables,
): symbol => {
  const fieldArguments = fieldNode.arguments;

  if (fieldArguments == null || fieldArguments.length === 0) {
    return getOrInsert(plainFieldKeyCache, fieldNode, computePlainFieldKey);
  }

  return memoizeByNodeAndVariables(
    fieldKeyCache,
    fieldNode,
    variables,
    computeFieldKey,
  );
};

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
  node: FieldNode | InlineFragmentNode,
  variables: AnyVariables,
): boolean => {
  if (!Array.isArray(node.directives)) {
    return false;
  }

  return node.directives.some((directive: DirectiveNode) => {
    const name = directive.name.value;

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
