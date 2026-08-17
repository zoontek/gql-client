import { isRecord } from "../utils";
import { REQUESTED_KEYS } from "./keys";
import { createEmptyCacheEntry, isCacheEntry, type CacheEntry } from "./types";

// The serialized cache stores symbols (all created with `Symbol.for`) as
// their descriptions, and cache entries as plain objects, so the whole
// structure round-trips through JSON. A raw leaf value could legitimately be
// an object holding one of the marker keys below, so `encodeValue` wraps such
// objects in `$esc`.
const SYM = "$sym";
const ENTRY = "$entry";
const ESC = "$esc";

/** A cache entry in its JSON-serializable form. */
export type SerializedEntry = {
  requestedKeys: string[];
  fields: [key: string, value: unknown][];
};

/**
 * The JSON-serializable form of a client's cache, returned by
 * `Client#extract` and accepted by `Client#restore`.
 */
export type SerializedCache = {
  entries: [key: string, entry: SerializedEntry][];
};

const encodeValue = (value: unknown): unknown => {
  if (typeof value === "symbol") {
    return { [SYM]: value.description ?? "" };
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }
  if (isCacheEntry(value)) {
    // oxlint-disable-next-line no-use-before-define
    return { [ENTRY]: encodeEntry(value) };
  }
  if (isRecord(value) && (SYM in value || ENTRY in value || ESC in value)) {
    return { [ESC]: value };
  }
  return value;
};

export const encodeEntry = (entry: CacheEntry): SerializedEntry => ({
  requestedKeys: [...entry[REQUESTED_KEYS]].map((key) => key.description ?? ""),
  // String keys (the connection ref) are skipped on purpose: connection
  // registrations hold live references and are rebuilt at write time.
  fields: Object.getOwnPropertySymbols(entry)
    .filter((key) => key !== REQUESTED_KEYS)
    .map((key) => [key.description ?? "", encodeValue(entry[key])]),
});

const decodeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (isRecord(value)) {
    if (typeof value[SYM] === "string") {
      return Symbol.for(value[SYM]);
    }
    if (isRecord(value[ENTRY])) {
      // oxlint-disable-next-line no-use-before-define
      return decodeEntry(value[ENTRY] as SerializedEntry);
    }
    if (ESC in value) {
      return value[ESC];
    }
  }
  return value;
};

export const decodeEntry = (serialized: SerializedEntry): CacheEntry => {
  const entry = createEmptyCacheEntry();

  for (const description of serialized.requestedKeys) {
    entry[REQUESTED_KEYS].add(Symbol.for(description));
  }
  for (const [description, value] of serialized.fields) {
    entry[Symbol.for(description)] = decodeValue(value);
  }

  return entry;
};
