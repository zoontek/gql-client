import { expect, test } from "bun:test";

import { stableStringify } from "../../src/utils";

test("stableStringify gives a BigInt and a string different keys", () => {
  const bigint = stableStringify({ id: BigInt(1) });

  expect(bigint).not.toBe(stableStringify({ id: "1n" }));
  expect(bigint).not.toBe(stableStringify({ id: "\u00001n" }));
});
