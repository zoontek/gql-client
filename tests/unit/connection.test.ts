import { describe, expect, spyOn, test } from "bun:test";

import { ClientCache } from "../../src/cache/cache";
import type { Connection, JsonValue } from "../../src/types";
import { doc, inDevelopment, setup } from "./helpers";

type Item = { __typename: string; id: string };

const readItems = (read: () => JsonValue | undefined): Connection<Item> =>
  (read() as { items: Connection<Item> }).items;

const addItem = (cache: ClientCache, item: Record<string, JsonValue>): void => {
  const fields = Object.keys(item).join(" ");

  cache.writeOperation(
    doc(`mutation M { addItem { ${fields} } }`),
    { __typename: "Mutation", addItem: { __typename: "Item", ...item } },
    {},
  );
};

// Runs `run` in development and checks it warned once about a skipped edge.
const expectSkippedEdge = (run: () => void): void => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});

  try {
    inDevelopment(run);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
};

const itemEdge = (id: string, cursor: string) => ({
  __typename: "ItemEdge",
  cursor,
  node: { __typename: "Item", id },
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
      edges: [null, itemEdge("i1", "c1")],
    },
  };

  const readEdges = (read: () => JsonValue | undefined): unknown[] =>
    (read() as { items: { edges: unknown[] } }).items.edges;

  test("keeps null edges and existing edges when prepending", () => {
    const { cache, read } = setup(connectionQuery, connectionResponse);

    cache.updateConnection(readItems(read), {
      prepend: [itemEdge("i1", "c0")],
    });

    expect(readEdges(read)).toEqual([
      itemEdge("i1", "c0"),
      null,
      itemEdge("i1", "c1"),
    ]);
  });

  test("skips null edges when prepending and appending", () => {
    const { cache, read } = setup(connectionQuery, connectionResponse);
    const items = readItems(read);

    cache.updateConnection(items, { prepend: [null, undefined] });
    cache.updateConnection(items, { append: [null] });

    expect(readEdges(read)).toEqual([null, itemEdge("i1", "c1")]);
  });

  test("remove only drops edges whose node id matches", () => {
    const { cache, read } = setup(connectionQuery, connectionResponse);

    cache.updateConnection(readItems(read), { remove: ["i1"] });

    expect(readEdges(read)).toEqual([null]);
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

    addItem(cache, { id: 2 });

    const items = (
      read() as { items: Connection<{ __typename: string; id: number }> }
    ).items;

    cache.updateConnection(items, {
      prepend: [{ node: { __typename: "Item", id: 2 } }],
    });

    type Read = { items: { edges: { node: { id: number } }[] } };
    const ids = (): number[] =>
      (read() as Read).items.edges.map((edge) => edge.node.id);

    expect(ids()).toEqual([2, 1]);

    cache.updateConnection(items, { remove: [1] });

    expect(ids()).toEqual([2]);
  });

  describe("new edges", () => {
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

    // Two queries of the same connection: Ids selects less than Names.
    const namesResponse = {
      __typename: "Query",
      items: {
        __typename: "ItemConnection",
        edges: [
          {
            __typename: "ItemEdge",
            node: { __typename: "Item", id: "i1", name: "a" },
          },
        ],
      },
    };

    const idsQuery = `query Ids { items { edges { node { id } } } }`;
    const namesQuery = doc(
      `query Names { items { edges { node { id name } } } }`,
    );

    test("adds a new edge whose node has every field the connection selects", () => {
      const { cache, read } = setup(itemQuery, itemResponse);
      const items = readItems(read);

      addItem(cache, { id: "i2", name: "b", done: true });

      cache.updateConnection(items, {
        append: [{ node: { __typename: "Item", id: "i2" } }],
      });

      const updated = read() as { items: { edges: { node: unknown }[] } };
      expect(updated.items.edges.map((edge) => edge.node)).toEqual([
        { __typename: "Item", id: "i1", name: "a", done: false },
        { __typename: "Item", id: "i2", name: "b", done: true },
      ]);
    });

    test("skips a new edge whose node misses fields the connection selects", () => {
      const { cache, document, read } = setup(itemQuery, itemResponse);
      cache.retainDocument(document);
      const before = read();

      addItem(cache, { id: "i2", name: "b" });

      expectSkippedEdge(() => {
        cache.updateConnection((before as { items: Connection<Item> }).items, {
          prepend: [{ node: { __typename: "Item", id: "i2" } }],
        });
      });

      expect(read()).toEqual(before);
    });

    test("skips a new edge when the connection selects other edge fields", () => {
      const { cache, document, read } = setup(
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
      cache.retainDocument(document);
      const items = readItems(read);

      addItem(cache, { id: "i2" });

      expectSkippedEdge(() => {
        cache.updateConnection(items, {
          append: [{ node: { __typename: "Item", id: "i2" } }],
        });
      });

      expect(read()).toMatchObject({ items: { edges: [{ role: "owner" }] } });
    });

    test("skips a new edge when another query of the connection selects more fields", () => {
      const { cache, read } = setup(idsQuery, namesResponse);

      cache.writeOperation(namesQuery, namesResponse, {});
      cache.retainDocument(namesQuery);

      addItem(cache, { id: "i2" });

      expectSkippedEdge(() => {
        cache.updateConnection(readItems(read), {
          append: [{ node: { __typename: "Item", id: "i2" } }],
        });
      });

      expect(cache.readOperation(namesQuery, {})).toBeDefined();
    });

    test("adds a new edge when the query that selects more fields is not mounted", () => {
      const { cache, document, read } = setup(idsQuery, namesResponse);
      cache.retainDocument(document);

      cache.writeOperation(namesQuery, namesResponse, {});
      const release = cache.retainDocument(namesQuery);
      release();

      addItem(cache, { id: "i2" });

      cache.updateConnection(readItems(read), {
        append: [{ node: { __typename: "Item", id: "i2" } }],
      });

      expect(read()).toMatchObject({
        items: { edges: [{ node: { id: "i1" } }, { node: { id: "i2" } }] },
      });
    });
  });
});

describe("connection registration", () => {
  type Ref = { __connectionRef: object };

  const postQuery = doc(
    `query Q($id: ID!) { post(id: $id) { id comments { edges { node { id } } } } }`,
  );

  const postResponse = {
    __typename: "Query",
    post: {
      __typename: "Post",
      id: "p1",
      comments: {
        __typename: "CommentConnection",
        edges: [
          {
            __typename: "CommentEdge",
            node: { __typename: "Comment", id: "c1" },
          },
        ],
      },
    },
  };

  const getCommentsInfo = (cache: ClientCache, variables: { id: string }) => {
    const result = cache.readOperation(postQuery, variables) as {
      post: { comments: Ref };
    };

    return cache.getConnectionInfo(result.post.comments.__connectionRef);
  };

  test("a connection keeps a copy of the variables, not the caller's object", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });
    const variables = { id: "p1" };
    cache.writeOperation(postQuery, postResponse, variables);

    const info = getCommentsInfo(cache, variables);
    const reader = info?.readers.values().next().value;

    expect(info?.variables).toEqual(variables);
    expect(info?.variables).not.toBe(variables);
    expect(reader?.variables).not.toBe(variables);
  });

  test("a mutation is not a reader of the connections it writes", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });
    cache.writeOperation(postQuery, postResponse, { id: "p1" });

    cache.writeOperation(
      doc(
        `mutation M { addComment { post { id comments { edges { node { id } } } } } }`,
      ),
      { __typename: "Mutation", addComment: postResponse },
      {},
    );

    const info = getCommentsInfo(cache, { id: "p1" });

    const documents = [...(info?.readers.values() ?? [])].map(
      (reader) => reader.document,
    );

    expect(documents).toEqual([postQuery]);
  });

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

    const result = read() as {
      items: Ref;
      films: ({ characters: Ref } | null)[];
    };

    const pathOf = (connection: Ref | undefined) =>
      connection == null
        ? undefined
        : cache.getConnectionInfo(connection.__connectionRef)?.path;

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

  test.each(["purge", "restore"] as const)(
    "a connection ref from before %s matches no later connection",
    (reset) => {
      const response = {
        __typename: "Query",
        items: { __typename: "ItemConnection", edges: [] },
      };
      const { cache, document, read } = setup(
        `query Q { items { edges { node { id } } } }`,
        response,
      );

      const ref = (read() as { items: Ref }).items.__connectionRef;

      if (reset === "purge") {
        cache.purge();
      } else {
        cache.restore(cache.extract());
      }

      cache.writeOperation(document, response, {});

      expect(cache.getConnectionInfo(ref)).toBeUndefined();
    },
  );
});
