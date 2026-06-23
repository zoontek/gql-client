import {
  Kind,
  visit,
  type DocumentNode,
  type FieldNode,
  type SelectionSetNode,
} from "@0no-co/graphql.web";

const TYPENAME_NODE: FieldNode = {
  kind: Kind.FIELD,
  name: {
    kind: Kind.NAME,
    value: "__typename",
  },
};

const transformDocumentCache = new Map<DocumentNode, DocumentNode>();

/**
 * Simplifies the query for internal processing by inlining all fragments and
 * adds `__typename` to all selection sets in the document.
 *
 * @param document
 * @returns transformedDocument
 */
export const transformDocument = (document: DocumentNode): DocumentNode => {
  const cachedDocument = transformDocumentCache.get(document);
  let operationDefinitionFound = false;

  if (cachedDocument != null) {
    return cachedDocument;
  }

  const transformedDocument = visit(document, {
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

    [Kind.SELECTION_SET]: (selectionSet): SelectionSetNode => {
      const hasTypename = selectionSet.selections.some(
        (selection) =>
          selection.kind === Kind.FIELD &&
          selection.name.value === "__typename",
      );

      if (hasTypename) {
        return selectionSet;
      }

      return {
        ...selectionSet,
        selections: [TYPENAME_NODE, ...selectionSet.selections],
      };
    },
  });

  transformDocumentCache.set(document, transformedDocument);
  return transformedDocument;
};
