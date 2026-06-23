import { Future, Option, Result } from "@bloodyowl/boxed";
import { Request, badStatusToError, emptyToError } from "@bloodyowl/request";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import {
  ClientCache,
  type ConnectionInfo,
  type SchemaConfig,
} from "./cache/cache";
import {
  type ClientError,
  InvalidGraphQLResponseError,
  parseGraphQLError,
} from "./errors";
import { addTypenames, getOperationName, inlineFragments } from "./graphql/ast";
import { printDocument } from "./graphql/printDocument";
import type { AnyVariables, Connection, Edge } from "./types";

export type ClientConfig = {
  url: string;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
  schemaConfig: SchemaConfig;
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
  private transformedDocuments: Map<TypedDocumentNode, TypedDocumentNode>;

  public constructor(config: ClientConfig) {
    this.url = config.url;
    this.credentials = config.credentials ?? "same-origin";
    this.headers = config.headers ?? {};

    this.cache = new ClientCache(config.schemaConfig);
    this.subscribers = new Set<() => void>();
    this.transformedDocuments = new Map<TypedDocumentNode, TypedDocumentNode>();
  }

  private getTransformedDocument(
    document: TypedDocumentNode,
  ): TypedDocumentNode {
    const cached = this.transformedDocuments.get(document);

    if (cached != null) {
      return cached;
    } else {
      const transformedDocument = inlineFragments(addTypenames(document));
      this.transformedDocuments.set(document, transformedDocument);
      return transformedDocument;
    }
  }

  public subscribe(fn: () => void): () => boolean {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  public request<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
    { connectionUpdates }: RequestOptions<Data, Variables> = {},
  ): Future<Result<Data, ClientError>> {
    const transformedDocument = this.getTransformedDocument(document);

    return Request.make({
      url: this.url,
      method: "POST",
      type: "json",
      credentials: this.credentials,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        operationName: getOperationName(transformedDocument),
        query: printDocument(transformedDocument),
        variables,
      }),
    })
      .mapOkToResult(badStatusToError)
      .mapOkToResult(emptyToError)
      .mapOkToResult((payload) => {
        if (payload != null && typeof payload === "object") {
          if ("errors" in payload && Array.isArray(payload.errors)) {
            return Result.Error(payload.errors.map(parseGraphQLError));
          }
          if ("data" in payload && payload.data != null) {
            return Result.Ok(payload.data);
          }
        }
        return Result.Error(new InvalidGraphQLResponseError(payload));
      })
      .mapOk((data) => data as Data)
      .tapOk((data) => {
        this.cache.writeOperation(transformedDocument, data, variables);
      })
      .tapOk((data) => {
        if (connectionUpdates !== undefined) {
          connectionUpdates.forEach((getUpdate) => {
            getUpdate({ data, variables, prepend, append, remove }).map(
              ([connection, update]) => {
                this.cache.updateConnection(connection, update);
              },
            );
          });
        }
      })
      .tap((result) => {
        this.cache.setOperationInCache(transformedDocument, variables, result);
        this.subscribers.forEach((func) => {
          func();
        });
      });
  }

  public readFromCache<Data, Variables extends AnyVariables = AnyVariables>(
    document: TypedDocumentNode<Data, Variables>,
    variables: NoInfer<Variables>,
  ): Option<Result<unknown, unknown>> {
    const transformedDocument = this.getTransformedDocument(document);

    const cached = this.cache.getOperationFromCache(
      transformedDocument,
      variables,
    );

    if (cached.isSome() && cached.get().isError()) {
      return cached;
    }

    return this.cache.readOperation(transformedDocument, variables);
  }

  public getCachedConnection(id: number): ConnectionInfo | undefined {
    return this.cache.getCachedConnection(id);
  }
}
