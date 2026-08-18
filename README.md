<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zoontek/gql-client/main/public/logo-dark.svg">
    <img alt="@zoontek/gql-client" height="96" src="https://raw.githubusercontent.com/zoontek/gql-client/main/public/logo-light.svg">
  </picture>

  <h1>@zoontek/gql-client</h1>

  <p>A simple, typesafe GraphQL client for React</p>

[![mit licence](https://img.shields.io/dub/l/vibe-d.svg?style=for-the-badge)](https://github.com/zoontek/gql-client/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@zoontek/gql-client?style=for-the-badge)](https://www.npmjs.org/package/@zoontek/gql-client)
[![bundlephobia](https://img.shields.io/bundlephobia/minzip/@zoontek/gql-client?label=size&style=for-the-badge)](https://bundlephobia.com/result?p=@zoontek/gql-client)

</div>

## Features

- Typed queries and mutations, from your generated `TypedDocumentNode`s.
- A normalized cache, shared by every query.
- Suspense-first hooks: `useQuery`, `useDeferredQuery`, `useMutation`.
- Cursor pagination helpers for Relay-style connections.
- Server-side rendering with a cache handoff.
- Works with React DOM and React Native.

## Installation

```bash
$ yarn add @zoontek/gql-client
# --- or ---
$ npm install --save @zoontek/gql-client
```

## Quick start

Create a client and make it available to your app:

```tsx
import { Client, ClientProvider } from "@zoontek/gql-client";
import schemaConfig from "./schemaConfig.json";

const client = new Client({
  url: "https://api.example.com/graphql",
  schemaConfig,
});

const Root = () => (
  <ClientProvider value={client}>
    <App />
  </ClientProvider>
);
```

Then query from any component:

```tsx
import { useQuery } from "@zoontek/gql-client";
import { graphql } from "./gql";

const PostQuery = graphql(`
  query Post($postId: ID!) {
    post(id: $postId) {
      id
      title
      body
    }
  }
`);

const Post = ({ postId }: { postId: string }) => {
  const [{ data }] = useQuery(PostQuery, { postId });

  return data.post == null ? (
    <div>Post not found</div>
  ) : (
    <article>
      <h1>{data.post.title}</h1>
      <p>{data.post.body}</p>
    </article>
  );
};
```

The full setup (schema config generation, Suspense and error boundaries) is in the [getting started guide](https://zoontek.github.io/gql-client).

## Credits

This library is based on [@bloodyowl/graphql-client](https://github.com/bloodyowl/graphql-client).

## Links

- 📕 [**Documentation**](https://zoontek.github.io/gql-client)
- ⚖️ [**License**](./LICENSE)
