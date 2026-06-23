import {
  Kind,
  print,
  visit,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type SelectionNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

type MergeableNode = Exclude<SelectionNode, FragmentSpreadNode>;

const TYPENAME_NODE: FieldNode = {
  kind: Kind.FIELD,
  name: {
    kind: Kind.NAME,
    value: "__typename",
  },
};

const createSelectionSet = (
  selections: readonly MergeableNode[],
): SelectionSetNode => ({
  kind: Kind.SELECTION_SET,
  selections,
});

const getNodeKey = (node: MergeableNode): string => {
  if (node.kind === Kind.FIELD) {
    const alias: string = node.alias?.value ?? "";
    const name: string = node.name.value;

    const args: string =
      node.arguments
        ?.map((_) => `${_.name.value}:${print(_.value)}`)
        .join(",") ?? "";

    return `FIELD:${alias}:${name}:${args}`;
  } else {
    const type: string = node.typeCondition?.name.value ?? "";
    return `INLINE_FRAGMENT:${type}`;
  }
};

const transformDocumentCache = new Map<TypedDocumentNode, TypedDocumentNode>();

/**
 * Simplifies the query for internal processing by inlining all fragments and
 * adds `__typename` to all selection sets in the document.
 *
 * @param document
 * @returns transformedDocument
 */
export const transformDocument = (
  // oxlint-disable-next-line typescript/no-explicit-any
  document: TypedDocumentNode<any, any>,
): TypedDocumentNode => {
  const cachedDocument = transformDocumentCache.get(document);

  if (cachedDocument != null) {
    return cachedDocument;
  }

  const fragmentDefinitions = new Map<string, FragmentDefinitionNode>();
  let operationDefinitionFound = false;

  visit(document, {
    [Kind.FRAGMENT_DEFINITION]: (node: FragmentDefinitionNode) => {
      fragmentDefinitions.set(node.name.value, node);
    },
  });

  const merge = (
    map: Map<string, MergeableNode>,
    node: MergeableNode,
  ): void => {
    const key = getNodeKey(node);
    const prev = map.get(key);

    if (prev == null) {
      map.set(key, node);
    } else if (prev.selectionSet != null && node.selectionSet != null) {
      map.set(key, {
        ...prev,
        selectionSet: createSelectionSet(
          // oxlint-disable-next-line no-use-before-define
          inline([
            ...prev.selectionSet.selections,
            ...node.selectionSet.selections,
          ]),
        ),
      });
    }
  };

  const inline = (
    nodes: readonly SelectionNode[],
  ): readonly MergeableNode[] => {
    const map = new Map<string, MergeableNode>();

    for (const node of nodes) {
      if (node.kind === Kind.FRAGMENT_SPREAD) {
        const name = node.name.value;

        const selections =
          fragmentDefinitions.get(name)?.selectionSet.selections;

        if (selections == null) {
          throw new Error(`Fragment "${name}" is not defined.`);
        }

        for (const node of inline(selections)) {
          merge(map, node);
        }
      } else {
        const selections = node.selectionSet?.selections;
        const copy = { ...node };

        if (selections != null) {
          copy.selectionSet = createSelectionSet(inline(selections));
        }

        merge(map, copy);
      }
    }

    return [...map.values()];
  };

  const transformedDocument = visit(document, {
    [Kind.FRAGMENT_DEFINITION]: () => null,

    [Kind.OPERATION_DEFINITION]: (node) => {
      if (!operationDefinitionFound) {
        operationDefinitionFound = true;
        return node;
      }

      if (process.env.NODE_ENV === "development") {
        const operationName = node.name?.value;

        console.warn(
          "This library doesn't support declaring multiple operations in a single document." +
            (operationName != null
              ? `Ignoring operation ${operationName}`
              : ""),
        );
      }

      return null;
    },

    [Kind.SELECTION_SET]: (node): SelectionSetNode => {
      const selections = inline(node.selections);

      const hasTypename = selections.some(
        (selection) =>
          selection.kind === Kind.FIELD &&
          selection.name.value === "__typename",
      );

      return createSelectionSet(
        hasTypename ? selections : [TYPENAME_NODE, ...selections],
      );
    },
  });

  transformDocumentCache.set(document, transformedDocument);
  return transformedDocument;
};
