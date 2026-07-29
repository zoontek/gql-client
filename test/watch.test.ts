import { parse } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { describe, expect, test } from "bun:test";
import { ClientCache } from "../src/cache/cache";
import { entriesOverlap } from "../src/cache/watch";
import { transformDocument } from "../src/graphql/transformDocument";
import type { AnyVariables, JsonValue } from "../src/types";

const doc = (source: string): TypedDocumentNode =>
  transformDocument(parse(source) as unknown as TypedDocumentNode);

const write = (
  cache: ClientCache,
  source: string,
  response: JsonValue,
  variables: AnyVariables = {},
): Map<object, Set<symbol>> => {
  const touched = new Map<object, Set<symbol>>();
  cache.writeOperation(doc(source), response, variables, touched);
  return touched;
};

const read = (
  cache: ClientCache,
  source: string,
  variables: AnyVariables = {},
): Map<object, Set<symbol>> => {
  const watched = new Map<object, Set<symbol>>();
  const result = cache.readOperation(doc(source), variables, watched);
  expect(result).toBeDefined();
  return watched;
};

describe("dependency tracking (watch.ts)", () => {
  test("two queries selecting different root fields don't overlap", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });

    write(cache, `query Q1 { user { id name } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "u1", name: "Jane" },
    });

    const touchedByQ1Write = write(cache, `query Q1 { user { id name } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "u1", name: "Jane 2" },
    });

    write(cache, `query Q2 { account { id name } }`, {
      __typename: "Query",
      account: { __typename: "Account", id: "a1", name: "First" },
    });

    const watchedQ1 = read(cache, `query Q1 { user { id name } }`);
    const watchedQ2 = read(cache, `query Q2 { account { id name } }`);

    // Both queries hang off the shared "Query" root cache entry. Without
    // field-level tracking, a write to `user` would look like it touches Q2
    // as well, since they'd be indistinguishable at the entry level.
    expect(entriesOverlap(watchedQ1, touchedByQ1Write)).toBe(true);
    expect(entriesOverlap(watchedQ2, touchedByQ1Write)).toBe(false);
  });

  test("a write to a shared entity overlaps every query that read it", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });

    write(cache, `query Q3 { post(id: "1") { id title author { id name } } }`, {
      __typename: "Query",
      post: {
        __typename: "Post",
        id: "1",
        title: "Hello",
        author: { __typename: "User", id: "u1", name: "Jane" },
      },
    });

    write(
      cache,
      `query Q4 { comment(id: "1") { id text author { id name } } }`,
      {
        __typename: "Query",
        comment: {
          __typename: "Comment",
          id: "1",
          text: "Nice post",
          author: { __typename: "User", id: "u1", name: "Jane" },
        },
      },
    );

    const watchedQ3 = read(
      cache,
      `query Q3 { post(id: "1") { id title author { id name } } }`,
    );
    const watchedQ4 = read(
      cache,
      `query Q4 { comment(id: "1") { id text author { id name } } }`,
    );

    const touchedByMutation = write(
      cache,
      `mutation UpdateUser {
        updateUser(id: "u1") { id name }
      }`,
      {
        __typename: "Mutation",
        updateUser: { __typename: "User", id: "u1", name: "Jane Doe" },
      },
    );

    // Both Q3 and Q4 read `User<u1>.name`, so a mutation updating it must
    // reach both, even though it never mentions `post` or `comment`.
    expect(entriesOverlap(watchedQ3, touchedByMutation)).toBe(true);
    expect(entriesOverlap(watchedQ4, touchedByMutation)).toBe(true);
  });

  test("a write to an unrelated entity overlaps nothing", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });

    write(cache, `query Q5 { user(id: "1") { id name } }`, {
      __typename: "Query",
      user: { __typename: "User", id: "u1", name: "Jane" },
    });

    const watchedQ5 = read(cache, `query Q5 { user(id: "1") { id name } }`);

    const touchedByOtherWrite = write(
      cache,
      `mutation UpdateOther { updateUser(id: "u2") { id name } }`,
      {
        __typename: "Mutation",
        updateUser: { __typename: "User", id: "u2", name: "Someone else" },
      },
    );

    expect(entriesOverlap(watchedQ5, touchedByOtherWrite)).toBe(false);
  });

  test("updateConnection's edge write overlaps a read of the same connection", () => {
    const cache = new ClientCache({ interfaceToTypes: {} });

    write(
      cache,
      `query Q6 { items(first: 2) { edges { cursor node { id } } } }`,
      {
        __typename: "Query",
        items: {
          __typename: "ItemConnection",
          edges: [
            {
              __typename: "ItemEdge",
              cursor: "c1",
              node: { __typename: "Item", id: "i1" },
            },
          ],
        },
      },
    );

    const watchedQ6 = read(
      cache,
      `query Q6 { items(first: 2) { edges { cursor node { id } } } }`,
    );

    const connection = {
      edges: [{ cursor: "c1", node: { __typename: "Item", id: "i1" } }],
      pageInfo: {},
      __connectionRef: 0,
    };

    const touched = new Map<object, Set<symbol>>();
    cache.updateConnection(
      connection,
      {
        append: [
          {
            __typename: "ItemEdge",
            cursor: "c2",
            node: { __typename: "Item", id: "i2" },
          },
        ],
      },
      touched,
    );

    expect(entriesOverlap(watchedQ6, touched)).toBe(true);
  });

  test("entriesOverlap treats an unscoped (undefined) side as matching anything", () => {
    const touched = new Map<object, Set<symbol>>([
      [{}, new Set([Symbol("field")])],
    ]);

    expect(entriesOverlap(undefined, touched)).toBe(true);
    expect(entriesOverlap(touched, undefined)).toBe(true);
    expect(entriesOverlap(undefined, undefined)).toBe(true);
  });
});
