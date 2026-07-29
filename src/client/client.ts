import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { ClientCache, type ConnectionInfo, type Schema } from "../cache/cache";
import { entriesOverlap, type WatchedEntriesBox } from "../cache/watch";
import { getOperationName } from "../graphql/ast";
import { printDocument } from "../graphql/print";
import { transformDocument } from "../graphql/transform";
import type { AnyVariables, Connection, Edge, JsonValue } from "../types";
import { isRecord, serializeVariables } from "../utils";
import { ClientError } from "./errors";

export type ClientConfig = {
  url: string;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
  timeout?: number;
  schema: Schema;
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

export type GetConnectionUpdate<
  Data,
  Variables extends AnyVariables = AnyVariables,
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

type RequestOptions<Data, Variables extends AnyVariables = AnyVariables> = {
  connectionUpdates?: GetConnectionUpdate<Data, Variables>[] | undefined;
};

export class Client {
  private url: string;
  private credentials: RequestCredentials;
  private headers: Record<string, string>;
  private timeout: number;

  private cache: ClientCache;
  private subscribers: Map<() => void, WatchedEntriesBox>;

  private inflightRequests: WeakMap<object, Map<string, Promise<unknown>>>;

  public constructor(config: ClientConfig) {
    this.url = config.url;
    this.credentials = config.credentials ?? "same-origin";
    this.timeout = config.timeout ?? 10_000;

    this.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(config.headers ?? {}),
    };

    this.cache = new ClientCache(config.schema);
    this.subscribers = new Map();
    this.inflightRequests = new WeakMap();
  }

  // `watched` is a mutable box a subscriber can update (via `readFromCache`'s
  // `watched` out-param) after every read, without re-subscribing. Omitting it
  // — as any direct caller outside the provided hooks would — keeps it
  // unscoped, matching every write, which is the previous global-notify
  // behavior.
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

  public request<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    { connectionUpdates }: RequestOptions<Data, Variables> = {},
  ): Promise<Data> {
    const controller = new AbortController();
    const transformedDocument = transformDocument(document);

    let timer: ReturnType<typeof setTimeout> | undefined;

    if (Number.isFinite(this.timeout) && this.timeout >= 0) {
      timer = setTimeout(() => {
        controller.abort(ClientError.timeout(this.url, this.timeout));
      }, this.timeout);
    }

    return fetch(this.url, {
      cache: "no-store",
      credentials: this.credentials,
      headers: this.headers,
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        operationName: getOperationName(transformedDocument),
        query: printDocument(transformedDocument),
        variables,
      }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw ClientError.httpStatus(response);
        }

        const json: JsonValue = await response.json().catch(() => null);

        if (isRecord(json)) {
          if ("errors" in json && Array.isArray(json.errors)) {
            throw ClientError.graphql(this.url, response, json.errors);
          }

          if ("data" in json && json.data != null) {
            return json.data;
          }
        }

        throw ClientError.malformedResponse(this.url, response);
      })
      .then((json) => {
        // The server response is trusted to match `Data`, the shape the caller's
        // `TypedDocumentNode` declares — nothing short of runtime schema
        // validation could verify that from a parsed JSON payload alone.
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

  // Suspense-friendly request: deduplicates concurrent requests for the same
  // document and variables so a component can safely call this on every render
  // and `use()` the returned promise. The same promise instance is handed out
  // until it settles, which is what lets `use()` suspend on it.
  public query<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    options: RequestOptions<Data, Variables> = {},
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

    const promise = this.request(document, variables, options);
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

  public readFromCache<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    watched?: Map<object, Set<symbol>>,
  ): JsonValue | undefined {
    const transformedDocument = transformDocument(document);
    return this.cache.readOperation(transformedDocument, variables, watched);
  }

  public getCachedConnection(id: number): ConnectionInfo | undefined {
    return this.cache.getCachedConnection(id);
  }
}
