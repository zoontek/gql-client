import { parse } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { describe, expect, test } from "bun:test";
import { ClientCache, type Schema } from "../src/cache/cache";
import { transformDocument } from "../src/graphql/transformDocument";
import type { AnyVariables, JsonValue } from "../src/types";

// Build a transformed document directly from a query string, decoupled from
// the gql.tada schema so we can freely exercise read-path branches.
const doc = (source: string): TypedDocumentNode =>
  transformDocument(parse(source) as unknown as TypedDocumentNode);

const setup = (
  source: string,
  response: JsonValue,
  variables: AnyVariables = {},
  schema: Schema = { interfaceToTypes: {} },
) => {
  const cache = new ClientCache(schema);
  const document = doc(source);
  cache.writeOperation(document, response, variables);
  return {
    cache,
    document,
    read: () => cache.readOperation(document, variables),
  };
};

// Asserts the read result is plain JSON: no symbol-keyed cache metadata leaks
// into what consumers receive.
const expectNoSymbolKeys = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(expectNoSymbolKeys);
  } else if (value != null && typeof value === "object") {
    expect(Object.getOwnPropertySymbols(value)).toHaveLength(0);
    Object.values(value).forEach(expectNoSymbolKeys);
  }
};

describe("readOperation", () => {
  test("reads a basic entity with nested object and scalars", () => {
    const { read } = setup(
      `query Q($id: ID!) {
        user(id: $id) {
          id
          firstName
          lastName
          address { city zip }
        }
      }`,
      {
        __typename: "Query",
        user: {
          __typename: "User",
          id: "1",
          firstName: "Jane",
          lastName: "Doe",
          address: { __typename: "Address", city: "Paris", zip: "75001" },
        },
      },
      { id: "1" },
    );

    const result = read() as Record<string, Record<string, unknown>>;

    expect(result).toMatchObject({
      user: {
        id: "1",
        firstName: "Jane",
        lastName: "Doe",
        address: { city: "Paris", zip: "75001" },
      },
    });
    expectNoSymbolKeys(result);
  });

  test("returns a referentially stable value across reads", () => {
    const { read } = setup(`query Q { me { id name } }`, {
      __typename: "Query",
      me: { __typename: "User", id: "1", name: "Jo" },
    });

    const a = read();
    const b = read();

    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  test("preserves field aliases", () => {
    const { read } = setup(`query Q { account { handle: name owner: id } }`, {
      __typename: "Query",
      account: { __typename: "Account", handle: "First", owner: "acc-1" },
    });

    expect(read()).toMatchObject({
      account: { handle: "First", owner: "acc-1" },
    });
  });

  test("reads scalar lists and entity lists with null elements", () => {
    const { read } = setup(
      `query Q {
        tags
        items { id label }
      }`,
      {
        __typename: "Query",
        tags: ["a", "b", "c"],
        items: [
          { __typename: "Item", id: "i1", label: "One" },
          null,
          { __typename: "Item", id: "i2", label: "Two" },
        ],
      },
    );

    expect(read()).toMatchObject({
      tags: ["a", "b", "c"],
      items: [{ id: "i1", label: "One" }, null, { id: "i2", label: "Two" }],
    });
  });

  test("keeps null nested objects as null", () => {
    const { read } = setup(`query Q { user { id avatar { url } } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "1", avatar: null },
    });

    expect(read()).toMatchObject({ user: { id: "1", avatar: null } });
  });

  test("returns undefined when a requested field is not cached", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });
    const written = doc(`query Q { user { id name } }`);
    cache.writeOperation(
      written,
      {
        __typename: "Query",
        user: { __typename: "User", id: "1", name: "Jo" },
      },
      {},
    );

    // A superset query asking for an uncached field must miss.
    const superset = doc(`query Q { user { id name email } }`);
    expect(cache.readOperation(superset, {})).toBeUndefined();
  });

  describe("inline fragments", () => {
    const schema: Schema = { interfaceToTypes: { Animal: ["Dog", "Cat"] } };

    test("narrows to the matching type and skips incompatible fragments", () => {
      const { read } = setup(
        `query Q {
          pet {
            __typename
            id
            name
            ... on Dog { barkVolume }
            ... on Cat { meowVolume }
          }
        }`,
        {
          __typename: "Query",
          pet: {
            __typename: "Dog",
            id: "1",
            name: "Rex",
            barkVolume: 11,
          },
        },
        {},
        schema,
      );

      const result = read() as { pet: Record<string, unknown> };

      expect(result.pet).toMatchObject({
        __typename: "Dog",
        id: "1",
        name: "Rex",
        barkVolume: 11,
      });
      // The Cat fragment is incompatible, so its field must be absent (and not
      // cause a cache miss).
      expect(result.pet).not.toHaveProperty("meowVolume");
      expectNoSymbolKeys(result);
    });

    test("reads fields shared between the base selection and a matching fragment", () => {
      const { read } = setup(
        `query Q {
          pet {
            __typename
            id
            name
            ... on Dog { name barkVolume }
          }
        }`,
        {
          __typename: "Query",
          pet: { __typename: "Dog", id: "1", name: "Rex", barkVolume: 11 },
        },
        {},
        schema,
      );

      expect((read() as { pet: unknown }).pet).toMatchObject({
        id: "1",
        name: "Rex",
        barkVolume: 11,
      });
    });

    test("matches a concrete type against an interface type condition", () => {
      const { read } = setup(
        `query Q {
          pet {
            __typename
            id
            ... on Animal { name }
          }
        }`,
        {
          __typename: "Query",
          pet: { __typename: "Dog", id: "1", name: "Rex" },
        },
        {},
        schema,
      );

      expect((read() as { pet: unknown }).pet).toMatchObject({
        __typename: "Dog",
        id: "1",
        name: "Rex",
      });
    });
  });

  describe("@skip / @include directives", () => {
    test("omits a field skipped with @skip(if: true)", () => {
      const { read } = setup(
        `query Q {
          user {
            id
            name
            email @skip(if: true)
          }
        }`,
        {
          __typename: "Query",
          user: { __typename: "User", id: "1", name: "Jo" },
        },
      );

      const result = read() as { user: Record<string, unknown> };
      expect(result.user).toMatchObject({ id: "1", name: "Jo" });
      expect(result.user).not.toHaveProperty("email");
    });

    test("omits a field excluded with @include(if: false)", () => {
      const { read } = setup(
        `query Q {
          user {
            id
            secret @include(if: false)
          }
        }`,
        { __typename: "Query", user: { __typename: "User", id: "1" } },
      );

      const result = read() as { user: Record<string, unknown> };
      expect(result.user).toMatchObject({ id: "1" });
      expect(result.user).not.toHaveProperty("secret");
    });

    test("reads a field kept with @include(if: true)", () => {
      const { read } = setup(
        `query Q {
          user {
            id
            name @include(if: true)
          }
        }`,
        {
          __typename: "Query",
          user: { __typename: "User", id: "1", name: "Jo" },
        },
      );

      expect((read() as { user: unknown }).user).toMatchObject({
        id: "1",
        name: "Jo",
      });
    });
  });

  test("reads fields with arguments resolved from variables", () => {
    const { read } = setup(
      `query Q($first: Int!) {
        items(first: $first) {
          edges { node { id } }
        }
      }`,
      {
        __typename: "Query",
        items: {
          __typename: "ItemConnection",
          edges: [
            { __typename: "ItemEdge", node: { __typename: "Item", id: "i1" } },
          ],
        },
      },
      { first: 2 },
    );

    expect(read()).toMatchObject({
      items: { edges: [{ node: { id: "i1" } }] },
    });
  });
});
