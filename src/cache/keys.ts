import {
  OperationTypeNode,
  type OperationDefinitionNode,
} from "@0no-co/graphql.web";

import { isRecord } from "../utils";

// Field keys written to an entry. A read misses when the selection requires a
// key that is not in this set.
export const REQUESTED_KEYS = Symbol.for("__requestedKeys");

export const CONNECTION_REF = "__connectionRef";

// Non-enumerable, so JSON.stringify, Object.keys and spreads skip the ref.
export const setConnectionRef = (target: object, ref: unknown): void => {
  Object.defineProperty(target, CONNECTION_REF, { value: ref });
};

export const TYPENAME_KEY = Symbol.for("__typename");

export const EDGES_KEY = Symbol.for("edges");

export const NODE_KEY = Symbol.for("node");

export const CURSOR_KEY = Symbol.for("cursor");

// A mutation root has no entry key, because it is never read back.
export const getRootEntryKey = (
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

// A typename never contains `<`, so the first `<` and the last `>` delimit the
// id, even if the id contains angle brackets.
export const getIdFromEntryKey = (entryKey: symbol): string | undefined => {
  const description = entryKey.description ?? "";
  const start = description.indexOf("<");
  return start === -1 ? undefined : description.slice(start + 1, -1);
};

// An object with a typename and an id gets the key `Typename<id>`. An object
// without an id has no key and is stored inline in its parent.
export const getEntryKey = (json: unknown): symbol | undefined => {
  if (!isRecord(json) || typeof json.__typename !== "string") {
    return undefined;
  }

  const { __typename: typename, id } = json;

  if (
    typename === "Mutation" ||
    typename === "Query" ||
    typename === "Subscription"
  ) {
    return Symbol.for(typename);
  }

  // An Int id and its string form give the same key.
  return typeof id === "string" || typeof id === "number"
    ? Symbol.for(`${typename}<${id}>`)
    : undefined;
};

// Read result when the cache does not have a required field. A cached `null` or
// `undefined` is a valid value, so it cannot signal a miss.
export const MISS = Symbol("MISS");
