import type { AnyVariables } from "./types";

export const REQUESTED_KEYS = Symbol.for("__requestedKeys");

export const CONNECTION_REF = "__connectionRef";

export const TYPENAME_KEY = Symbol.for("__typename");
export const EDGES_KEY = Symbol.for("edges");
export const NODE_KEY = Symbol.for("node");
export const CURSOR_KEY = Symbol.for("cursor");

export const containsAll = <T>(a: Set<T>, b: Set<T>): boolean => {
  for (const key of b) {
    if (!a.has(key)) {
      return false;
    }
  }
  return true;
};

export const isRecord = (
  value: unknown,
): value is Record<PropertyKey, unknown> => {
  return value != null && typeof value === "object" && !Array.isArray(value);
};

export const hasOwn = (obj: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

// oxlint-disable-next-line typescript/explicit-module-boundary-types, typescript/no-explicit-any
export const deepEqual = (a: any, b: any): boolean => {
  if (Object.is(a, b)) {
    return true;
  }

  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (!hasOwn(b, key) || !deepEqual(a[key], b[key])) {
      return false;
    }
  }

  return true;
};

export const serializeVariables = (variables: AnyVariables): string => {
  return JSON.stringify(variables, Object.keys(variables).sort());
};

export const filterMap = <A, B>(
  array: readonly A[],
  fn: (item: A) => B | undefined,
): B[] => {
  const result: B[] = [];

  for (const item of array) {
    const mapped = fn(item);

    if (mapped !== undefined) {
      result.push(mapped);
    }
  }

  return result;
};
