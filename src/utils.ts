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
    a == null ||
    typeof b !== "object" ||
    b == null
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

// Deterministic serialization: object keys are sorted at every depth, so the
// same logical value always produces the same string regardless of key
// order. Sorting goes through a replacer function: a replacer array would
// whitelist top-level keys at every depth and drop all nested values.
export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, val: unknown) =>
    isRecord(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((key) => [key, val[key]]),
        )
      : val,
  );

// Memoized by object identity. Variables objects are never mutated in place
// here, a change always produces a new object, so caching the serialized
// form per reference is safe. Turns a JSON.stringify on every cache read and
// in-flight lookup into a WeakMap hit when the same variables are reused
// across renders, which is the common case.
const serializedVariablesCache = new WeakMap<AnyVariables, string>();

export const serializeVariables = (variables: AnyVariables): string => {
  const cached = serializedVariablesCache.get(variables);

  if (cached != null) {
    return cached;
  }

  const serialized = stableStringify(variables);
  serializedVariablesCache.set(variables, serialized);
  return serialized;
};

export const deepCopy = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map(deepCopy) as T;
  }
  if (isRecord(value)) {
    const copy: Record<PropertyKey, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = deepCopy(value[key]);
    }
    return copy as T;
  }
  return value;
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
