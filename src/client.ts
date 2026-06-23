import { Option } from "@bloodyowl/boxed";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import { ClientCache, type ConnectionInfo, type Schema } from "./cache/cache";
import { getOperationName } from "./graphql/ast";
import { printDocument } from "./graphql/printDocument";
import { transformDocument } from "./graphql/transformDocument";
import { makeRequest } from "./request";
import type { AnyVariables, Connection, Edge, JsonValue } from "./types";

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
}) => Option<ConnectionUpdate<unknown>>;

type RequestOptions<Data, Variables extends AnyVariables = AnyVariables> = {
  connectionUpdates?: GetConnectionUpdate<Data, Variables>[] | undefined;
};

export class Client {
  private url: string;
  private credentials: RequestCredentials;
  private headers: Record<string, string>;

  private cache: ClientCache;
  private subscribers: Set<() => void>;

  public constructor(config: ClientConfig) {
    this.url = config.url;
    this.credentials = config.credentials ?? "same-origin";
    this.headers = config.headers ?? {};

    this.cache = new ClientCache(config.schema);
    this.subscribers = new Set<() => void>();
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
          getUpdate({
            data: data as Data,
            variables,
            prepend,
            append,
            remove,
          }).map(([connection, update]) => {
            this.cache.updateConnection(connection, update);
          });
        });
      }

      this.subscribers.forEach((fn) => fn());

      return data as Data;
    });
  }

  public readFromCache<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
  ): Option<JsonValue> {
    const transformedDocument = transformDocument(document);
    return this.cache.readOperation(transformedDocument, variables);
  }

  public getCachedConnection(id: number): ConnectionInfo | undefined {
    return this.cache.getCachedConnection(id);
  }
}
