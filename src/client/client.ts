import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import { ClientCache, type SchemaConfig } from "../cache/cache";
import { entriesOverlap, type WatchedEntriesBox } from "../cache/watch";
import { getOperationName } from "../gql/ast";
import { printDocument } from "../gql/print";
import { transformDocument } from "../gql/transform";
import type { AnyVariables, Connection, Edge, JsonValue } from "../types";
import { isRecord, serializeVariables } from "../utils";
import { ClientError } from "./errors";

export type RequestOptions = {
  /** Passed to `fetch` as `credentials`. Defaults to `"same-origin"`. */
  credentials?: RequestInit["credentials"];
  /** Extra HTTP headers merged into every request. */
  headers?: Record<string, string>;
  /** Passed to `fetch` as `integrity`, for subresource integrity checks. */
  integrity?: RequestInit["integrity"];
  /** Passed to `fetch` as `keepalive`, to let the request outlive a page unload. */
  keepalive?: RequestInit["keepalive"];
  /** Passed to `fetch` as `mode`. Not set by default, so `fetch`'s own default applies. */
  mode?: RequestInit["mode"];
  /** Request timeout in milliseconds. Defaults to `10_000`. Set to `Infinity` to disable. */
  timeout?: number;
};

export type ClientConfig = {
  /** GraphQL endpoint URL. All requests are sent here as HTTP POST. */
  url: string;
  /** Interface-to-implementing-types map, used by the cache to match fragments on interfaces. Generate it with `gql-schema-config`. */
  schemaConfig: SchemaConfig;
  /**
   * Options merged into every `fetch` call. Pass a function (sync or async)
   * to compute them fresh for each request, e.g. to read the latest auth
   * token. If the function throws or rejects, the request fails with a
   * `ClientError` whose `reason` is `"options"`.
   */
  requestOptions?:
    | RequestOptions
    | (() => RequestOptions | Promise<RequestOptions>);
};

type ConnectionUpdate<Node> = [
  Connection<Node>,
  { prepend: Edge<Node>[] } | { append: Edge<Node>[] } | { remove: string[] },
];

const prepend = <A>(
  connection: Connection<A>,
  edges: Edge<A>[],
): ConnectionUpdate<A> => {
  return [connection, { prepend: edges }];
};

const append = <A>(
  connection: Connection<A>,
  edges: Edge<A>[],
): ConnectionUpdate<A> => {
  return [connection, { append: edges }];
};

const remove = <A>(
  connection: Connection<A>,
  ids: string[],
): ConnectionUpdate<A> => {
  return [connection, { remove: ids }];
};

/**
 * Given a request's `data` and `variables`, returns how a cached connection
 * should change (prepend, append, or remove edges), or `undefined` to leave
 * it untouched. Pass an array of these as `connectionUpdates` to
 * `Client#mutate`, `Client#query`, or `useMutation`'s config.
 */
export type GetConnectionUpdate<
  Data,
  Variables extends AnyVariables,
> = (config: {
  data: Data;
  variables: Variables;
  prepend: <A>(
    connection: Connection<A>,
    edges: Edge<A>[],
  ) => ConnectionUpdate<A>;
  append: <A>(
    connection: Connection<A>,
    edges: Edge<A>[],
  ) => ConnectionUpdate<A>;
  remove: <A>(connection: Connection<A>, ids: string[]) => ConnectionUpdate<A>;
}) => ConnectionUpdate<unknown> | undefined;

/** Config accepted by `Client#mutate` and `useMutation`. */
export type MutationConfig<Data, Variables extends AnyVariables> = {
  /** Cache updates to apply to connections touched by this mutation's result. */
  connectionUpdates?: GetConnectionUpdate<Data, Variables>[] | undefined;
};

/**
 * A typesafe GraphQL client with a built-in normalized cache. Create one
 * instance per app and pass it to `ClientProvider`; `useQuery`, `useMutation`,
 * and the pagination hooks read and write through it.
 */
export class Client {
  /** @internal */
  public cache: ClientCache;

  private url: string;
  private inflightRequests: WeakMap<object, Map<string, Promise<unknown>>>;
  private subscribers: Map<() => void, WatchedEntriesBox>;

  private requestOptions:
    | RequestOptions
    | (() => RequestOptions | Promise<RequestOptions>);

  /**
   * Creates a client.
   *
   * @param config - See `ClientConfig` for the available options.
   */
  public constructor(config: ClientConfig) {
    this.cache = new ClientCache(config.schemaConfig);
    this.url = config.url;
    this.inflightRequests = new WeakMap();
    this.subscribers = new Map();
    this.requestOptions = config.requestOptions ?? {};
  }

  /**
   * Registers `fn` to be called after a write touches cache data `watched`
   * has read. Returns an unsubscribe function. Intended for internal use by
   * the provided hooks; most apps won't call this directly.
   *
   * `watched` is a mutable box a subscriber can update (via
   * `cache.readOperation`'s `watched` out-param) after every read, without
   * re-subscribing. Omitting it, as any direct caller outside the provided
   * hooks would, keeps it unscoped, matching every write.
   *
   * @param fn - Called after a write touches data `watched` has read.
   * @param watched - Tracks which cache entries this subscriber's reads have
   * touched. Defaults to an unscoped box, matching every write.
   * @returns A function that unsubscribes `fn`.
   */
  public subscribe(
    fn: () => void,
    watched: WatchedEntriesBox = { current: undefined },
  ): () => void {
    this.subscribers.set(fn, watched);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  // Notifies only subscribers whose last-known read touched one of the same
  // (cache entry, field) pairs this write touched, instead of every mounted
  // query. A subscriber with no successful read yet stays unscoped (see
  // `subscribe`), so its own eventual write still reaches it.
  private notify(touched: Map<object, Set<symbol>>): void {
    this.subscribers.forEach((watched, fn) => {
      if (entriesOverlap(watched.current, touched)) {
        fn();
      }
    });
  }

  /**
   * Sends `document` with `variables` to the server, writes the response
   * into the cache, and returns the response data. Not deduplicated; queries
   * read through `Client#query` instead.
   *
   * @param document - The document to send.
   * @param variables - The document's variables.
   * @param options.connectionUpdates - Optional list of `GetConnectionUpdate`
   * functions applied to the cache after the write, for prepending/appending/
   * removing edges of a connection touched by this request.
   * @returns The response data.
   */
  private async request<Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    { connectionUpdates }: MutationConfig<Data, Variables> = {},
  ): Promise<Data> {
    const controller = new AbortController();
    const transformedDocument = transformDocument(document);

    const {
      credentials,
      headers = {},
      integrity,
      keepalive,
      mode,
      timeout = 10_000,
    } = await Promise.resolve()
      .then(() =>
        typeof this.requestOptions === "function"
          ? this.requestOptions()
          : this.requestOptions,
      )
      .catch(() => {
        throw ClientError.options(this.url);
      });

    let timer: ReturnType<typeof setTimeout> | undefined;

    if (Number.isFinite(timeout) && timeout >= 0) {
      timer = setTimeout(() => {
        controller.abort(ClientError.timeout(this.url, timeout));
      }, timeout);
    }

    return fetch(this.url, {
      cache: "no-store",
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        operationName: getOperationName(transformedDocument),
        query: printDocument(transformedDocument),
        variables,
      }),
      ...(mode != null && { mode }),
      ...(credentials != null && { credentials }),
      ...(integrity != null && { integrity }),
      ...(keepalive != null && { keepalive }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw ClientError.status(response);
        }

        const json: JsonValue = await response.json().catch(() => null);

        if (isRecord(json)) {
          if ("errors" in json && Array.isArray(json.errors)) {
            throw ClientError.graphQL(this.url, response, json.errors);
          }

          if ("data" in json && json.data != null) {
            return json.data;
          }
        }

        throw ClientError.malformed(this.url, response);
      })
      .then((json) => {
        // The response is trusted to match `Data`, the shape the caller's
        // `TypedDocumentNode` declares. Nothing short of runtime schema
        // validation could confirm that from a parsed JSON payload alone.
        const data: Data = json as Data;
        const touched = new Map<object, Set<symbol>>();

        this.cache.writeOperation(
          transformedDocument,
          json,
          variables,
          touched,
        );

        if (connectionUpdates !== undefined) {
          connectionUpdates.forEach((getUpdate) => {
            const result = getUpdate({
              data,
              variables,
              prepend,
              append,
              remove,
            });

            if (result !== undefined) {
              const [connection, update] = result;
              this.cache.updateConnection(connection, update, touched);
            }
          });
        }

        this.notify(touched);

        return data;
      })
      .catch((error) => {
        if (error instanceof ClientError) {
          throw error;
        }

        throw ClientError.network(this.url);
      })
      .finally(() => {
        clearTimeout(timer);
      });
  }

  /**
   * Sends `document` with `variables` to the server, writes the response
   * into the cache, and returns the response data. Used for mutations and any
   * one-off request that shouldn't be deduplicated; queries read through
   * `Client#query` instead.
   *
   * @param document - The document to send.
   * @param variables - The document's variables.
   * @param options.connectionUpdates - Optional list of `GetConnectionUpdate`
   * functions applied to the cache after the write, for prepending/appending/
   * removing edges of a connection touched by this request.
   * @returns The response data.
   */
  public mutate<Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    config: MutationConfig<Data, Variables> = {},
  ): Promise<Data> {
    return this.request(document, variables, config);
  }

  /**
   * Suspense-friendly request: deduplicates concurrent requests for the same
   * document and variables so a component can safely call this on every
   * render and `use()` the returned promise. The same promise instance is
   * handed out until it settles, which is what lets `use()` suspend on it.
   * Used internally by `useQuery`; most apps won't call this directly.
   *
   * @param document - The document to send.
   * @param variables - The document's variables.
   * @returns The response data. The same promise is returned for concurrent
   * calls with the same `document` and `variables`.
   */
  public query<Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
  ): Promise<Data> {
    const key = serializeVariables(variables);

    let documentRequests = this.inflightRequests.get(document);
    const existing = documentRequests?.get(key);

    if (existing !== undefined) {
      // The in-flight map is shared across every document, so a cached promise
      // is stored as `Promise<unknown>`; it was created by `request<Data>` below
      // for this exact document, so it does resolve to `Data`.
      return existing as Promise<Data>;
    }

    if (documentRequests === undefined) {
      documentRequests = new Map();
      this.inflightRequests.set(document, documentRequests);
    }

    const promise = this.request(document, variables);
    documentRequests.set(key, promise);

    // Clear the in-flight entry once settled so a later cache miss for the same
    // variables (e.g. after an invalidation) triggers a fresh request. Passing
    // the handler as both fulfilled and rejected reactions also marks the
    // promise as handled, so dropping it without `use()`-ing it never surfaces
    // an unhandled rejection. (`.finally()` can't be used here: it re-rejects
    // through a new promise that nobody handles.)
    const cleanup = (): void => {
      documentRequests.delete(key);
    };

    promise.then(cleanup, cleanup);

    return promise;
  }
}
