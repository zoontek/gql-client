import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { ClientCache, type ConnectionInfo, type Schema } from "./cache/cache";
import { getOperationName } from "./graphql/ast";
import { printDocument } from "./graphql/printDocument";
import { transformDocument } from "./graphql/transformDocument";
import { makeRequest } from "./request";
import type { AnyVariables, Connection, Edge, JsonValue } from "./types";
import { serializeVariables } from "./utils";

export type ClientConfig = {
  url: string;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
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

  private cache: ClientCache;
  private subscribers: Set<() => void>;

  private inflightRequests: WeakMap<
    TypedDocumentNode,
    Map<string, Promise<unknown>>
  >;

  public constructor(config: ClientConfig) {
    this.url = config.url;
    this.credentials = config.credentials ?? "same-origin";
    this.headers = config.headers ?? {};

    this.cache = new ClientCache(config.schema);
    this.subscribers = new Set<() => void>();
    this.inflightRequests = new WeakMap();
  }

  public subscribe(fn: () => void): () => boolean {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  public request<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    { connectionUpdates }: RequestOptions<Data, Variables> = {},
  ): Promise<Data> {
    const transformedDocument = transformDocument(document);

    return makeRequest({
      url: this.url,
      credentials: this.credentials,
      headers: this.headers,
      body: JSON.stringify({
        operationName: getOperationName(transformedDocument),
        query: printDocument(transformedDocument),
        variables,
      }),
    }).then((data) => {
      this.cache.writeOperation(transformedDocument, data, variables);

      if (connectionUpdates !== undefined) {
        connectionUpdates.forEach((getUpdate) => {
          const result = getUpdate({
            data: data as Data,
            variables,
            prepend,
            append,
            remove,
          });

          if (result !== undefined) {
            const [connection, update] = result;
            this.cache.updateConnection(connection, update);
          }
        });
      }

      this.subscribers.forEach((fn) => fn());

      return data as Data;
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
    const documentKey = document as unknown as TypedDocumentNode;
    const key = serializeVariables(variables);

    let documentRequests = this.inflightRequests.get(documentKey);
    const existing = documentRequests?.get(key);

    if (existing !== undefined) {
      return existing as Promise<Data>;
    }

    if (documentRequests === undefined) {
      documentRequests = new Map();
      this.inflightRequests.set(documentKey, documentRequests);
    }

    const promise = this.request(document, variables, options);
    documentRequests.set(key, promise);

    // Clear the in-flight entry once settled so a later cache miss for the same
    // variables (e.g. after an invalidation) triggers a fresh request. The
    // rejection handler also marks the promise as handled, so dropping it
    // without `use()`-ing it never surfaces an unhandled rejection.
    promise.then(
      () => documentRequests.delete(key),
      () => documentRequests.delete(key),
    );

    return promise;
  }

  public readFromCache<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
  ): JsonValue | undefined {
    const transformedDocument = transformDocument(document);
    return this.cache.readOperation(transformedDocument, variables);
  }

  public getCachedConnection(id: number): ConnectionInfo | undefined {
    return this.cache.getCachedConnection(id);
  }
}
