export const identity = <T>(value: T): T => value;

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
): value is Record<PropertyKey, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

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

export const getOrInsert = <K, V>(
  map: { get(key: K): V | undefined; set(key: K, value: V): unknown },
  key: K,
  create: (key: K) => NoInfer<V>,
): V => {
  let value = map.get(key);

  if (value === undefined) {
    value = create(key);
    map.set(key, value);
  }

  return value;
};

export const deleteIfUnchanged = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
): void => {
  if (map.get(key) === value) {
    map.delete(key);
  }
};

// Sorts object keys at each depth, so equal variables give the same string. A
// bigint becomes "\0<value>n". A string that starts with "\0" gets one more
// "\0", so it cannot look like a bigint.
const BIGINT_MARK = "\u0000";

export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, val: unknown) => {
    if (isRecord(val)) {
      return Object.fromEntries(
        Object.keys(val)
          .sort()
          .map((key) => [key, val[key]]),
      );
    }

    if (typeof val === "bigint") {
      return `${BIGINT_MARK}${val}n`;
    }

    if (typeof val === "string" && val.startsWith(BIGINT_MARK)) {
      return `${BIGINT_MARK}${val}`;
    }

    return val;
  });

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

export const shallowEqualArrays = <T>(
  a: readonly T[],
  b: readonly T[],
): boolean =>
  a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
