import { parse } from "@0no-co/graphql.web";
import type { TypedDocumentNode } from "@graphql-typed-document-node/core";

import type { AnyVariables } from "../../src/types";

/** Parses `source` and casts it to a typed document for component-test fixtures. */
export const gql = <Data, Variables extends AnyVariables>(
  source: string,
): TypedDocumentNode<Data, Variables> =>
  parse(source) as unknown as TypedDocumentNode<Data, Variables>;
