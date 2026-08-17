import { describe, expect, test } from "bun:test";

import { parse } from "@0no-co/graphql.web";

import { printDocument } from "../../src/graphql/print";
import { transformDocument } from "../../src/graphql/transform";

const printTransformed = (source: string): string =>
  printDocument(transformDocument(parse(source)));

describe("transformDocument", () => {
  test("keeps selections with different directives separate", () => {
    const printed = printTransformed(
      `query Q($x: Boolean!) {
        me @include(if: $x) { name }
        me { id }
      }`,
    );

    // The conditional and unconditional selections must both survive: merging
    // them would apply @include to the unconditional one (or drop it).
    expect(printed).toContain("me@include(if:$x)");
    expect(printed.match(/me[@{]/g)).toHaveLength(2);
  });

  test("keeps inline fragments with different directives separate", () => {
    const printed = printTransformed(
      `query Q($x: Boolean!) {
        pet {
          ... on Dog @include(if: $x) { barkVolume }
          ... on Dog { name }
        }
      }`,
    );

    expect(printed).toContain("...on Dog@include(if:$x)");
    expect(printed.match(/\.\.\.on Dog/g)).toHaveLength(2);
  });

  test("puts __typename first in every selection set", () => {
    const printed = printTransformed(
      `query Q {
        pet {
          id
          ... on Dog { barkVolume }
          __typename
        }
      }`,
    );

    // A single __typename per selection set, always in first position, even
    // when the document wrote it after an inline fragment.
    expect(printed).toContain("pet{__typename id");
    expect(printed.match(/__typename/g)).toHaveLength(3);
  });

  test("merges duplicated fields with identical directives", () => {
    const printed = printTransformed(
      `query Q {
        me { name }
        me { id }
      }`,
    );

    expect(printed.match(/me\{/g)).toHaveLength(1);
  });
});
