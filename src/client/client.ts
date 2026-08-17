import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import { ClientCache, type SchemaConfig } from "../cache/cache";
import type { SerializedCache } from "../cache/serialize";
import { entriesOverlap, type WatchedEntriesBox } from "../cache/watch";
import { getOperationName } from "../graphql/ast";
import { printDocument } from "../graphql/print";
import { transformDocument } from "../graphql/transform";
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

/** The GraphQL request payload, before it gets serialized as the `fetch` body. */
export type RequestPayload = {
  operationName: string | undefined;
  query: string;
  variables: AnyVariables;
};

export type ClientConfig = {
  /** GraphQL endpoint URL. All requests are sent here as HTTP POST. */
  url: string;
  /** Interface-to-implementing-types map, used by the cache to match fragments on interfaces. Generate it with `gql-schema-config`. */
  schemaConfig: SchemaConfig;
  /**
   * Options merged into every `fetch` call. Pass a function (sync or async)
   * to compute them fresh for each request, e.g. to read the latest auth
   * token. It receives the request payload, so options can depend on the
   * operation being sent. If the function throws or rejects, the request
   * fails with a `ClientError` whose `reason` is `"options"`.
   */
  requestOptions?:
    | RequestOptions
    | ((payload: RequestPayload) => RequestOptions | Promise<RequestOptions>);
};

// One stored request per (document, serialized variables): joined while in
// flight, reusable after success (see `Client#query`), dropped on rejection.
type StoredRequest = {
  promise: Promise<unknown>;
  settled: boolean;
};

// A mounted query, registered by `useQuery` for the duration of its mount, so
// `Client#refetch` knows what to re-send.
type ActiveQuery = {
  // oxlint-disable-next-line typescript/no-explicit-any
  document: TypedDocumentNode<any, any>;
  variables: AnyVariables;
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
  private requests: WeakMap<object, Map<string, StoredRequest>>;
  private subscribers: Map<() => void, WatchedEntriesBox>;
  private activeQueries: Set<ActiveQuery>;
  private version = 0;

  private requestOptions:
    | RequestOptions
    | ((payload: RequestPayload) => RequestOptions | Promise<RequestOptions>);

  /**
   * @param config - See `ClientConfig` for the available options.
   */
  public constructor(config: ClientConfig) {
    this.cache = new ClientCache(config.schemaConfig);
    this.url = config.url;
    this.requests = new WeakMap();
    this.subscribers = new Map();
    this.activeQueries = new Set();
    this.requestOptions = config.requestOptions ?? {};
  }

  /**
   * Registers a mounted query so `Client#refetch` can re-send it. Returns an
   * unregister function. Called by `useQuery` for the duration of its mount;
   * most apps won't call this directly.
   *
   * @internal
   */
  public registerQuery<Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
  ): () => void {
    const activeQuery: ActiveQuery = { document, variables };
    this.activeQueries.add(activeQuery);
    return () => {
      this.activeQueries.delete(activeQuery);
    };
  }

  /**
   * Re-sends every mounted query (each `useQuery` currently rendered) and
   * writes the fresh responses into the cache. Components keep showing their
   * current data until each response lands. Call it when data may have gone
   * stale, e.g. on the Page Visibility API's `visibilitychange` in the
   * browser, or on React Native's `AppState` change back to `"active"`.
   *
   * Identical queries mounted more than once are sent a single time. A failed
   * request leaves the affected components on their cached data.
   *
   * @returns A promise resolved once every refetch has settled, e.g. to end a
   * pull-to-refresh indicator.
   */
  public async refetch(): Promise<void> {
    await Promise.allSettled(
      [...this.activeQueries].map(({ document, variables }) =>
        this.query(document, variables, { refresh: true }),
      ),
    );
  }

  /**
   * Monotonic counter bumped on every cache-affecting event (response write,
   * connection update, purge). Lets subscribers skip re-reading the cache
   * when nothing changed since their last read.
   *
   * @internal
   */
  public getVersion(): number {
    return this.version;
  }

  /**
   * Serializes the cache to a JSON string, to transfer server-side fetched
   * data to the browser. Every `<` is escaped as `\u003c`, so the string is
   * safe to embed directly in a `<script>` tag. On the server, prefetch with
   * `Client#query`, render, and inline the string in the HTML; in the
   * browser, pass the resulting value to `Client#restore` before rendering,
   * so queries hydrate from the cache instead of fetching again.
   *
   * @returns The serialized cache as script-safe JSON text.
   */
  public extract(): string {
    return JSON.stringify(this.cache.extract()).replace(/</g, "\\u003c");
  }

  /**
   * Replaces the cache content with data produced by `Client#extract`, then
   * notifies subscribers. Accepts the JSON string itself, or the object it
   * evaluates to when inlined in a `<script>` tag. Call it before rendering,
   * on a client that has not fetched anything yet.
   *
   * @param data - The serialized cache to load.
   */
  public restore(data: SerializedCache | string): void {
    this.cache.restore(
      typeof data === "string" ? (JSON.parse(data) as SerializedCache) : data,
    );
    this.requests = new WeakMap();
    this.version++;
    this.subscribers.forEach((_watched, fn) => {
      fn();
    });
  }

  /**
   * Drops every cache entry, registered connection, and stored query
   * response, then notifies all subscribers so mounted queries fetch fresh
   * data. Call it when all cached data must go, e.g. on logout.
   */
  public purge(): void {
    this.cache.purge();
    this.requests = new WeakMap();
    this.version++;
    this.subscribers.forEach((_watched, fn) => {
      fn();
    });
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
    this.version++;
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

    const payload: RequestPayload = {
      operationName: getOperationName(transformedDocument),
      query: printDocument(transformedDocument),
      variables,
    };

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
          ? this.requestOptions(payload)
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
      body: JSON.stringify(payload),
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

        if (connectionUpdates != null) {
          connectionUpdates.forEach((getUpdate) => {
            const result = getUpdate({
              data,
              variables,
              prepend,
              append,
              remove,
            });

            if (result != null) {
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
   * Suspense-friendly request: returns one stable promise per `document` and
   * `variables` so a component can safely call this on every render and
   * `use()` the returned promise. The promise stays stored after it resolves:
   * a cache read that still misses after its response was written re-renders
   * with the settled promise instead of firing a new request, so a persistent
   * miss can never loop network requests. Pass `refresh: true` to replace a
   * settled promise with a fresh request (an in-flight one is always joined).
   * A rejected promise is dropped, so the next call retries. Used internally
   * by `useQuery` and `useDeferredQuery`; most apps won't call this directly.
   *
   * @param document - The document to send.
   * @param variables - The document's variables.
   * @param options.refresh - Send a new request even if a settled one is
   * stored. Defaults to `false`.
   * @returns The response data. The same promise is returned for calls with
   * the same `document` and `variables` until it rejects or is refreshed.
   */
  public query<Data, Variables extends AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    { refresh = false }: { refresh?: boolean } = {},
  ): Promise<Data> {
    const key = serializeVariables(variables);

    let documentRequests = this.requests.get(document);
    const existing = documentRequests?.get(key);

    if (existing != null && (!existing.settled || !refresh)) {
      // The request map is shared across every document, so a stored promise
      // is typed `Promise<unknown>`; it was created by `request<Data>` below
      // for this exact document, so it does resolve to `Data`.
      return existing.promise as Promise<Data>;
    }

    if (documentRequests == null) {
      documentRequests = new Map();
      this.requests.set(document, documentRequests);
    }

    const requests = documentRequests;
    const promise = this.request(document, variables);
    const stored: StoredRequest = { promise, settled: false };

    requests.set(key, stored);

    // Attaching both reactions also marks the promise as handled, so dropping
    // it without `use()`-ing it never surfaces an unhandled rejection.
    // (`.finally()` can't be used here: it re-rejects through a new promise
    // that nobody handles.)
    promise.then(
      () => {
        stored.settled = true;
      },
      () => {
        stored.settled = true;

        // Drop failed requests so a retry (an ErrorBoundary reset, a
        // `refetch()`) fires a fresh one instead of replaying the rejection.
        if (requests.get(key) === stored) {
          requests.delete(key);
        }
      },
    );

    return promise;
  }
}
