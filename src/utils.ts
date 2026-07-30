import type { AnyVariables } from "./types";

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

  // Array fast path, skips the Object.keys allocation and hasOwn checks
  // below. Worth it: GraphQL results are array-heavy (lists, connection
  // edges), and this runs on every cache read.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
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

// Memoized by object identity. Variables objects are never mutated in place
// here, a change always produces a new object, so caching the serialized
// form per reference is safe. Turns a JSON.stringify on every cache read and
// in-flight lookup into a WeakMap hit when the same variables are reused
// across renders, which is the common case.
const serializedVariablesCache = new WeakMap<AnyVariables, string>();

export const serializeVariables = (variables: AnyVariables): string => {
  const cached = serializedVariablesCache.get(variables);

  if (cached !== undefined) {
    return cached;
  }

  const serialized = JSON.stringify(variables, Object.keys(variables).sort());
  serializedVariablesCache.set(variables, serialized);
  return serialized;
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
