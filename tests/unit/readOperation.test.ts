import { describe, expect, spyOn, test } from "bun:test";

import { parse } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import type { Connection } from "../../src";
import { ClientCache, type SchemaConfig } from "../../src/cache/cache";
import { transformDocument } from "../../src/graphql/transform";
import type { AnyVariables, JsonValue } from "../../src/types";

// ES2021, out of the project's ES2019 lib. Bun has it.
declare class WeakRef<T extends object> {
  constructor(target: T);
  deref(): T | undefined;
}

// Build a transformed document directly from a query string, decoupled from
// the gql.tada schema so we can freely exercise read-path branches.
const doc = (source: string): TypedDocumentNode =>
  transformDocument(parse(source));

const setup = (
  source: string,
  response: JsonValue,
  variables: AnyVariables = {},
  schemaConfig: SchemaConfig = { interfaceToTypes: {} },
) => {
  const cache = new ClientCache(schemaConfig);
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

// Runs `run` with `NODE_ENV` set to "development", for dev-only warnings.
const inDevelopment = (run: () => void): void => {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  try {
    run();
  } finally {
    if (nodeEnv == null) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
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

  test("keeps references to unchanged subtrees when a field changes", () => {
    const { cache, read } = setup(
      `query Q { users { id name address { city } } }`,
      {
        __typename: "Query",
        users: [
          {
            __typename: "User",
            id: "1",
            name: "Jo",
            address: { __typename: "Address", city: "Paris" },
          },
          {
            __typename: "User",
            id: "2",
            name: "Al",
            address: { __typename: "Address", city: "Lyon" },
          },
        ],
      },
    );

    type Result = {
      users: { name: string; address: { city: string } }[];
    };

    const before = read() as Result;

    cache.writeOperation(
      doc(`query U { user(id: "2") { id name } }`),
      {
        __typename: "Query",
        user: { __typename: "User", id: "2", name: "Bo" },
      },
      {},
    );

    const after = read() as Result;

    expect(after).not.toBe(before);
    expect(after.users).not.toBe(before.users);
    expect(after.users[0]).toBe(before.users[0]);
    expect(after.users[1]).not.toBe(before.users[1]);
    expect(after.users[1]?.name).toBe("Bo");
    expect(after.users[1]?.address).toBe(before.users[1]?.address);
  });

  test("does not share results across cache instances", () => {
    const document = doc(`query Q { me { id name } }`);
    const response = {
      __typename: "Query",
      me: { __typename: "User", id: "1", name: "Jo" },
    };

    const a = new ClientCache({ interfaceToTypes: {} });
    const b = new ClientCache({ interfaceToTypes: {} });
    a.writeOperation(document, response, {});
    b.writeOperation(document, response, {});

    const resultA = a.readOperation(document, {});
    const resultB = b.readOperation(document, {});

    expect(resultB).toEqual(resultA);
    expect(resultB).not.toBe(resultA);
  });

  test("drops stored results on purge and restore", () => {
    const response = {
      __typename: "Query",
      me: { __typename: "User", id: "1", name: "Jo" },
    };
    const { cache, document, read } = setup(
      `query Q { me { id name } }`,
      response,
    );

    const first = read();
    cache.purge();
    cache.writeOperation(document, response, {});
    const afterPurge = read();

    expect(afterPurge).toEqual(first);
    expect(afterPurge).not.toBe(first);

    cache.restore(cache.extract());
    const afterRestore = read();

    expect(afterRestore).toEqual(first);
    expect(afterRestore).not.toBe(afterPurge);
  });

  test("drops a stored result once its variables object is gone", () => {
    const { cache, document } = setup(
      `query Q($id: ID!) { user(id: $id) { id } }`,
      {
        __typename: "Query",
        user: { __typename: "User", id: "1" },
      },
      { id: "1" },
    );

    const readOnce = (): WeakRef<object> => {
      const result = cache.readOperation(document, { id: "1" });
      if (result == null || typeof result !== "object") {
        throw new Error("Expected a cache hit");
      }
      return new WeakRef(result);
    };

    const ref = readOnce();
    Bun.gc(true);

    expect(ref.deref()).toBeUndefined();
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

  test("keys cached fields by name, not by alias", () => {
    const { cache, read } = setup(`query A { user { id title: name } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "1", title: "Alice" },
    });

    const roleQuery = doc(`query B { me { id title: role } }`);
    cache.writeOperation(
      roleQuery,
      {
        __typename: "Query",
        me: { __typename: "User", id: "1", title: "admin" },
      },
      {},
    );

    expect(read()).toMatchObject({ user: { id: "1", title: "Alice" } });
    expect(cache.readOperation(roleQuery, {})).toMatchObject({
      me: { id: "1", title: "admin" },
    });
  });

  test("shares a cached field between different aliases", () => {
    const { cache } = setup(`query A { user { id name } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "1", name: "Alice" },
    });

    expect(
      cache.readOperation(doc(`query B { user { id title: name } }`), {}),
    ).toMatchObject({ user: { id: "1", title: "Alice" } });
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
    const schemaConfig: SchemaConfig = {
      interfaceToTypes: { Animal: ["Dog", "Cat"] },
    };

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
        schemaConfig,
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

    test("applies a fragment spread only to its type condition", () => {
      const { read } = setup(
        `query Q {
          pet { id ...DogFields ...CatFields }
        }
        fragment DogFields on Dog { barkVolume }
        fragment CatFields on Cat { meowVolume }`,
        {
          __typename: "Query",
          pet: { __typename: "Dog", id: "1", barkVolume: 11 },
        },
        {},
        schemaConfig,
      );

      expect(read()).toEqual({
        __typename: "Query",
        pet: { __typename: "Dog", id: "1", barkVolume: 11 },
      });
    });

    test("applies a fragment spread on an interface to its implementations", () => {
      const { read } = setup(
        `query Q {
          pet { id ...AnimalFields }
        }
        fragment AnimalFields on Animal { name }`,
        {
          __typename: "Query",
          pet: { __typename: "Dog", id: "1", name: "Rex" },
        },
        {},
        schemaConfig,
      );

      expect(read()).toEqual({
        __typename: "Query",
        pet: { __typename: "Dog", id: "1", name: "Rex" },
      });
    });

    test("skips a fragment spread excluded by @include(if: false)", () => {
      const { read } = setup(
        `query Q($withName: Boolean!) {
          pet { id ...AnimalFields @include(if: $withName) }
        }
        fragment AnimalFields on Animal { name }`,
        {
          __typename: "Query",
          pet: { __typename: "Dog", id: "1" },
        },
        { withName: false },
        schemaConfig,
      );

      expect(read()).toEqual({
        __typename: "Query",
        pet: { __typename: "Dog", id: "1" },
      });
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
        schemaConfig,
      );

      expect((read() as { pet: unknown }).pet).toMatchObject({
        id: "1",
        name: "Rex",
        barkVolume: 11,
      });
    });

    test("merges an object field shared between the base selection and a fragment adding subfields", () => {
      const { read } = setup(
        `query Q {
          pet {
            __typename
            id
            owner { id }
            ... on Dog { owner { id nickname } }
          }
        }`,
        {
          __typename: "Query",
          pet: {
            __typename: "Dog",
            id: "1",
            owner: { __typename: "Owner", id: "o1", nickname: "Sam" },
          },
        },
        {},
        schemaConfig,
      );

      // The fragment's `owner` selects a subfield the base selection doesn't:
      // it must resolve from the cache entry, not from the partial result.
      expect((read() as { pet: unknown }).pet).toMatchObject({
        owner: { id: "o1", nickname: "Sam" },
      });
    });

    test("keeps base-selection subfields when a fragment re-selects a subset", () => {
      const { read } = setup(
        `query Q {
          pet {
            __typename
            id
            owner { id nickname }
            ... on Dog { owner { id } }
          }
        }`,
        {
          __typename: "Query",
          pet: {
            __typename: "Dog",
            id: "1",
            owner: { __typename: "Owner", id: "o1", nickname: "Sam" },
          },
        },
        {},
        schemaConfig,
      );

      // The fragment's narrower `owner` selection must not drop `nickname`,
      // already resolved by the base selection.
      expect((read() as { pet: unknown }).pet).toMatchObject({
        owner: { id: "o1", nickname: "Sam" },
      });
    });

    test("merges a list field shared between the base selection and a fragment", () => {
      const { read } = setup(
        `query Q {
          pet {
            __typename
            id
            toys { id }
            ... on Dog { toys { id name } }
          }
        }`,
        {
          __typename: "Query",
          pet: {
            __typename: "Dog",
            id: "1",
            toys: [
              { __typename: "Toy", id: "t1", name: "Ball" },
              { __typename: "Toy", id: "t2", name: "Rope" },
            ],
          },
        },
        {},
        schemaConfig,
      );

      const result = read() as { pet: { toys: unknown } };

      expect(result.pet.toys).toEqual([
        { __typename: "Toy", id: "t1", name: "Ball" },
        { __typename: "Toy", id: "t2", name: "Rope" },
      ]);
      expectNoSymbolKeys(result);
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
        schemaConfig,
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

describe("directives and cache misses", () => {
  test("a field cached with @include(if: false) is a miss when the flag turns true", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });
    const document = doc(
      `query Q($flag: Boolean!) {
        user { id avatar @include(if: $flag) }
      }`,
    );

    cache.writeOperation(
      document,
      { __typename: "Query", user: { __typename: "User", id: "1" } },
      { flag: false },
    );

    expect(cache.readOperation(document, { flag: false })).toMatchObject({
      user: { id: "1" },
    });
    // The cache holds no avatar value, so this must be a miss (undefined,
    // triggering a fetch), not a silent success without the field.
    expect(cache.readOperation(document, { flag: true })).toBeUndefined();
  });

  test("a non-matching inline fragment does not mark its fields as cached", () => {
    const schemaConfig: SchemaConfig = {
      interfaceToTypes: { Node: ["User", "Post"] },
    };
    const cache = new ClientCache(schemaConfig);
    const withFragment = doc(`query A { node { id ... on Post { title } } }`);

    cache.writeOperation(
      withFragment,
      { __typename: "Query", node: { __typename: "User", id: "1" } },
      {},
    );

    expect(cache.readOperation(withFragment, {})).toMatchObject({
      node: { id: "1" },
    });

    // The server never returned `title`; a document requiring it directly
    // must miss instead of silently succeeding without the field.
    const withField = doc(`query B { node { id title } }`);
    expect(cache.readOperation(withField, {})).toBeUndefined();
  });

  test("applies the type condition when __typename is written after the fragment", () => {
    const { read } = setup(
      `query Q {
        pet {
          id
          ... on Dog { barkVolume }
          __typename
        }
      }`,
      { __typename: "Query", pet: { __typename: "Cat", id: "1" } },
      {},
      { interfaceToTypes: { Animal: ["Dog", "Cat"] } },
    );

    // The Dog fragment must be skipped for a Cat even though the document
    // wrote __typename after the fragment.
    expect(read()).toMatchObject({ pet: { __typename: "Cat", id: "1" } });
  });
});

describe("result isolation", () => {
  test("mutating a custom scalar object in the result does not corrupt the cache", () => {
    const { read } = setup(`query Q { user { id metadata } }`, {
      __typename: "Query",
      user: {
        __typename: "User",
        id: "1",
        metadata: { tags: ["a"] },
      },
    });

    const first = read() as { user: { metadata: { tags: string[] } } };
    first.user.metadata.tags.push("b");

    const second = read() as { user: { metadata: { tags: string[] } } };
    expect(second.user.metadata.tags).toEqual(["a"]);
  });
});

describe("updateConnection", () => {
  const connectionQuery = `query Q {
    items {
      __typename
      pageInfo { __typename endCursor hasNextPage }
      edges { __typename cursor node { __typename id } }
    }
  }`;

  const connectionResponse = {
    __typename: "Query",
    items: {
      __typename: "ItemConnection",
      pageInfo: { __typename: "PageInfo", endCursor: "c1", hasNextPage: true },
      edges: [
        null,
        {
          __typename: "ItemEdge",
          cursor: "c1",
          node: { __typename: "Item", id: "i1" },
        },
      ],
    },
  };

  test("keeps null edges and existing edges when prepending", () => {
    const { cache, read } = setup(connectionQuery, connectionResponse);
    const result = read() as {
      items: Connection<{ __typename: string; id: string }>;
    };

    cache.updateConnection(result.items, {
      prepend: [
        {
          __typename: "ItemEdge",
          cursor: "c0",
          node: { __typename: "Item", id: "i1" },
        },
      ],
    });

    const updated = read() as { items: { edges: unknown[] } };
    expect(updated.items.edges).toEqual([
      {
        __typename: "ItemEdge",
        cursor: "c0",
        node: { __typename: "Item", id: "i1" },
      },
      null,
      {
        __typename: "ItemEdge",
        cursor: "c1",
        node: { __typename: "Item", id: "i1" },
      },
    ]);
  });

  test("skips null edges when prepending and appending", () => {
    const { cache, read } = setup(connectionQuery, connectionResponse);
    const result = read() as {
      items: Connection<{ __typename: string; id: string }>;
    };

    cache.updateConnection(result.items, { prepend: [null, undefined] });
    cache.updateConnection(result.items, { append: [null] });

    const updated = read() as { items: { edges: unknown[] } };
    expect(updated.items.edges).toEqual([
      null,
      {
        __typename: "ItemEdge",
        cursor: "c1",
        node: { __typename: "Item", id: "i1" },
      },
    ]);
  });

  test("remove only drops edges whose node id matches", () => {
    const { cache, read } = setup(connectionQuery, connectionResponse);
    const result = read() as {
      items: Connection<{ __typename: string; id: string }>;
    };

    cache.updateConnection(result.items, { remove: ["i1"] });

    const updated = read() as { items: { edges: unknown[] } };
    expect(updated.items.edges).toEqual([null]);
  });

  const itemQuery = `query Q {
    items { edges { node { id name done } } }
  }`;

  const itemResponse = {
    __typename: "Query",
    items: {
      __typename: "ItemConnection",
      edges: [
        {
          __typename: "ItemEdge",
          node: { __typename: "Item", id: "i1", name: "a", done: false },
        },
      ],
    },
  };

  test("skips a new edge whose node misses fields the connection selects", () => {
    const { cache, read } = setup(itemQuery, itemResponse);
    const before = read();
    const result = before as {
      items: Connection<{ __typename: string; id: string }>;
    };

    cache.writeOperation(
      doc(`mutation M { addItem { id name } }`),
      {
        __typename: "Mutation",
        addItem: { __typename: "Item", id: "i2", name: "b" },
      },
      {},
    );

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    inDevelopment(() => {
      cache.updateConnection(result.items, {
        prepend: [{ node: { __typename: "Item", id: "i2" } }],
      });
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    expect(read()).toEqual(before);
  });

  test("skips a new edge when the connection selects other edge fields", () => {
    const { cache, read } = setup(
      `query Q {
        items { edges { role node { id } } }
      }`,
      {
        __typename: "Query",
        items: {
          __typename: "ItemConnection",
          edges: [
            {
              __typename: "ItemEdge",
              role: "owner",
              node: { __typename: "Item", id: "i1" },
            },
          ],
        },
      },
    );
    const result = read() as {
      items: Connection<{ __typename: string; id: string }>;
    };

    cache.writeOperation(
      doc(`mutation M { addItem { id } }`),
      { __typename: "Mutation", addItem: { __typename: "Item", id: "i2" } },
      {},
    );

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    inDevelopment(() => {
      cache.updateConnection(result.items, {
        append: [{ node: { __typename: "Item", id: "i2" } }],
      });
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    expect(read()).toMatchObject({ items: { edges: [{ role: "owner" }] } });
  });

  test("adds a new edge whose node has every field the connection selects", () => {
    const { cache, read } = setup(itemQuery, itemResponse);
    const result = read() as {
      items: Connection<{ __typename: string; id: string }>;
    };

    cache.writeOperation(
      doc(`mutation M { addItem { id name done } }`),
      {
        __typename: "Mutation",
        addItem: { __typename: "Item", id: "i2", name: "b", done: true },
      },
      {},
    );

    cache.updateConnection(result.items, {
      append: [{ node: { __typename: "Item", id: "i2" } }],
    });

    const updated = read() as { items: { edges: { node: unknown }[] } };
    expect(updated.items.edges.map((edge) => edge.node)).toEqual([
      { __typename: "Item", id: "i1", name: "a", done: false },
      { __typename: "Item", id: "i2", name: "b", done: true },
    ]);
  });
});

describe("numeric ids", () => {
  test("an entity with a number id is shared between queries", () => {
    const { cache, read } = setup(`query Q { me { id name } }`, {
      __typename: "Query",
      me: { __typename: "User", id: 1, name: "Jo" },
    });

    cache.writeOperation(
      doc(`query U { user(id: 1) { id name } }`),
      {
        __typename: "Query",
        user: { __typename: "User", id: 1, name: "Bo" },
      },
      {},
    );

    expect(read()).toEqual({
      __typename: "Query",
      me: { __typename: "User", id: 1, name: "Bo" },
    });
  });

  test("prepend and remove accept nodes with a number id", () => {
    const { cache, read } = setup(
      `query Q { items { edges { node { id } } } }`,
      {
        __typename: "Query",
        items: {
          __typename: "ItemConnection",
          edges: [
            { __typename: "ItemEdge", node: { __typename: "Item", id: 1 } },
          ],
        },
      },
    );

    cache.writeOperation(
      doc(`mutation M { addItem { id } }`),
      { __typename: "Mutation", addItem: { __typename: "Item", id: 2 } },
      {},
    );

    const result = read() as {
      items: Connection<{ __typename: string; id: number }>;
    };

    cache.updateConnection(result.items, {
      prepend: [{ node: { __typename: "Item", id: 2 } }],
    });

    type Read = { items: { edges: { node: { id: number } }[] } };
    const ids = (): number[] =>
      (read() as Read).items.edges.map((edge) => edge.node.id);

    expect(ids()).toEqual([2, 1]);

    cache.updateConnection(result.items, { remove: [1] });

    expect(ids()).toEqual([2]);
  });
});

describe("connection registration", () => {
  test("keeps the connection ref out of the visible result", () => {
    const { read } = setup(`query Q { items { edges { node { id } } } }`, {
      __typename: "Query",
      items: { __typename: "ItemConnection", edges: [] },
    });

    const result = read() as { items: object };

    expect(Object.keys(result.items)).toEqual(["__typename", "edges"]);
    expect(JSON.stringify(result)).not.toContain("__connectionRef");
    expect("__connectionRef" in result.items).toBe(true);
  });

  test("records the path of each connection in the query", () => {
    const pageInfo = { __typename: "PageInfo", hasNextPage: false };
    const characters = { __typename: "CharacterConnection", pageInfo };

    const { cache, read } = setup(
      `query Q {
        items(first: 1) { pageInfo { hasNextPage } }
        films {
          id
          ... on Film { characters(first: 2) { pageInfo { hasNextPage } } }
        }
      }`,
      {
        __typename: "Query",
        items: { __typename: "ItemConnection", pageInfo },
        films: [
          { __typename: "Film", id: "1", characters },
          null,
          { __typename: "Film", id: "2", characters },
        ],
      },
    );

    type Ref = { __connectionRef: number };
    const result = read() as {
      items: Ref;
      films: ({ characters: Ref } | null)[];
    };

    const pathOf = (connection: Ref | undefined) =>
      connection == null
        ? undefined
        : cache.getCachedConnection(connection.__connectionRef)?.pathInQuery;

    expect(pathOf(result.items)).toEqual(["items"]);
    expect(pathOf(result.films[0]?.characters)).toEqual([
      "films",
      0,
      "characters",
    ]);
    expect(pathOf(result.films[2]?.characters)).toEqual([
      "films",
      2,
      "characters",
    ]);
  });
});

describe("purge", () => {
  test("drops all cached data", () => {
    const { cache, read } = setup(`query Q { user { id } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "1" },
    });

    expect(read()).toMatchObject({ user: { id: "1" } });

    cache.purge();

    expect(read()).toBeUndefined();
  });

  test.each(["purge", "restore"] as const)(
    "a connection ref from before %s matches no later connection",
    (reset) => {
      const source = `query Q { items { edges { node { id } } } }`;
      const response = {
        __typename: "Query",
        items: { __typename: "ItemConnection", edges: [] },
      };
      const { cache, document, read } = setup(source, response);

      const before = read() as { items: { __connectionRef: number } };
      const ref = before.items.__connectionRef;

      if (reset === "purge") {
        cache.purge();
      } else {
        cache.restore(cache.extract());
      }

      cache.writeOperation(document, response, {});

      expect(cache.getCachedConnection(ref)).toBeUndefined();
    },
  );
});
