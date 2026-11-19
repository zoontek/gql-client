import { parse } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import { Client, type ClientConfig } from "../src/client/client";
import type { AnyVariables } from "../src/types";

export const gql = <Data, Variables extends AnyVariables>(
  source: string,
): TypedDocumentNode<Data, Variables> => parse(source);

export const createClient = (config: Partial<ClientConfig> = {}): Client =>
  new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    ...config,
  });

export type GreetingData = { greeting: string };
export type GreetingVariables = { id: string };

export const GreetingQuery = gql<GreetingData, GreetingVariables>(
  `query Greeting($id: ID!) { greeting(id: $id) }`,
);
