import { isRecord } from "../utils";
import { REQUESTED_KEYS } from "./keys";
import { createCacheEntry, isCacheEntry, type CacheEntry } from "./types";

// Symbols and nested entries become tagged objects, so the cache can go through
// JSON. A stored value that already has a tag key is wrapped in ESCAPE_TAG, so
// decodeValue does not read it as a tag.
const SYMBOL_TAG = "$sym";
const ENTRY_TAG = "$entry";
const ESCAPE_TAG = "$esc";

type SerializedEntry = {
  requestedKeys: string[];
  fields: [key: string, value: unknown][];
};

/** Cache content returned by `Client#extract`, once parsed. */
export type SerializedCache = {
  entries: [key: string, entry: SerializedEntry][];
};

const encodeValue = (value: unknown): unknown => {
  if (typeof value === "symbol") {
    return { [SYMBOL_TAG]: value.description ?? "" };
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }
  if (isCacheEntry(value)) {
    // oxlint-disable-next-line no-use-before-define
    return { [ENTRY_TAG]: encodeEntry(value) };
  }
  if (
    isRecord(value) &&
    (SYMBOL_TAG in value || ENTRY_TAG in value || ESCAPE_TAG in value)
  ) {
    return { [ESCAPE_TAG]: value };
  }
  return value;
};

export const encodeEntry = (entry: CacheEntry): SerializedEntry => ({
  requestedKeys: [...entry[REQUESTED_KEYS]].map((key) => key.description ?? ""),
  // Only symbol keys are serialized, so the connection ref is left out.
  // Connections are registered again when a response is written.
  fields: Object.getOwnPropertySymbols(entry)
    .filter((key) => key !== REQUESTED_KEYS)
    .map((key) => [key.description ?? "", encodeValue(entry[key])]),
});

const decodeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (isRecord(value)) {
    if (typeof value[SYMBOL_TAG] === "string") {
      return Symbol.for(value[SYMBOL_TAG]);
    }
    if (isRecord(value[ENTRY_TAG])) {
      // oxlint-disable-next-line no-use-before-define
      return decodeEntry(value[ENTRY_TAG] as SerializedEntry);
    }
    if (ESCAPE_TAG in value) {
      return value[ESCAPE_TAG];
    }
  }
  return value;
};

export const decodeEntry = (serialized: SerializedEntry): CacheEntry => {
  const entry = createCacheEntry();

  for (const description of serialized.requestedKeys) {
    entry[REQUESTED_KEYS].add(Symbol.for(description));
  }
  for (const [description, value] of serialized.fields) {
    entry[Symbol.for(description)] = decodeValue(value);
  }

  return entry;
};
