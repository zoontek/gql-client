import {
  OperationTypeNode,
  type OperationDefinitionNode,
} from "@0no-co/graphql.web";

export const REQUESTED_KEYS = Symbol.for("__requestedKeys");

export const CONNECTION_REF = "__connectionRef";

export const TYPENAME_KEY = Symbol.for("__typename");
export const EDGES_KEY = Symbol.for("edges");
export const NODE_KEY = Symbol.for("node");
export const CURSOR_KEY = Symbol.for("cursor");

// Cache-key conventions. The root entry of a query/subscription is keyed by its
// operation type; mutations are never read back, so they have no root key. Every
// other entry is keyed by `${typename}<${id}>` — a format `updateConnection`
// relies on when it parses ids back out of a node reference.
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
