/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never;
    };
import type { TypedDocumentNode as DocumentNode } from "@graphql-typed-document-node/core";
export type AllFilmsWithVariablesQueryQueryVariables = Exact<{
  first: number;
  after?: string | null | undefined;
}>;

export type AllFilmsWithVariablesQueryQuery = {
  allFilms: {
    " $fragmentRefs"?: { FilmsConnectionFragment: FilmsConnectionFragment };
  } | null;
};

export type FilmItemFragment = {
  id: string;
  title: string | null;
  releaseDate: string | null;
  producers: Array<string | null> | null;
} & { " $fragmentName"?: "FilmItemFragment" };

export type FilmCharactersConnectionFragment = {
  edges: Array<{
    node: { id: string; name: string | null } | null;
  } | null> | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} & { " $fragmentName"?: "FilmCharactersConnectionFragment" };

export type FilmDetailsQueryVariables = Exact<{
  filmId: string | number;
  first: number;
  after?: string | null | undefined;
}>;

export type FilmDetailsQuery = {
  film: {
    id: string;
    title: string | null;
    director: string | null;
    producers: Array<string | null> | null;
    openingCrawl: string | null;
    releaseDate: string | null;
    characterConnection: {
      " $fragmentRefs"?: {
        FilmCharactersConnectionFragment: FilmCharactersConnectionFragment;
      };
    } | null;
  } | null;
};

export type FilmsConnectionFragment = {
  edges: Array<{
    node:
      | ({ id: string } & {
          " $fragmentRefs"?: { FilmItemFragment: FilmItemFragment };
        })
      | null;
  } | null> | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} & { " $fragmentName"?: "FilmsConnectionFragment" };

export const FilmCharactersConnectionFragmentDoc = {
  kind: "Document",
  definitions: [
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmCharactersConnection" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "FilmCharactersConnection" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "edges" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "node" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: "Field",
            name: { kind: "Name", value: "pageInfo" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "hasNextPage" } },
                { kind: "Field", name: { kind: "Name", value: "endCursor" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FilmCharactersConnectionFragment, unknown>;
export const FilmItemFragmentDoc = {
  kind: "Document",
  definitions: [
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmItem" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "Film" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          { kind: "Field", name: { kind: "Name", value: "id" } },
          { kind: "Field", name: { kind: "Name", value: "title" } },
          { kind: "Field", name: { kind: "Name", value: "releaseDate" } },
          { kind: "Field", name: { kind: "Name", value: "producers" } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FilmItemFragment, unknown>;
export const FilmsConnectionFragmentDoc = {
  kind: "Document",
  definitions: [
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmsConnection" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "FilmsConnection" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "edges" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "node" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      {
                        kind: "FragmentSpread",
                        name: { kind: "Name", value: "FilmItem" },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: "Field",
            name: { kind: "Name", value: "pageInfo" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "hasNextPage" } },
                { kind: "Field", name: { kind: "Name", value: "endCursor" } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmItem" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "Film" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          { kind: "Field", name: { kind: "Name", value: "id" } },
          { kind: "Field", name: { kind: "Name", value: "title" } },
          { kind: "Field", name: { kind: "Name", value: "releaseDate" } },
          { kind: "Field", name: { kind: "Name", value: "producers" } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FilmsConnectionFragment, unknown>;
export const AllFilmsWithVariablesQueryDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "allFilmsWithVariablesQuery" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: {
            kind: "Variable",
            name: { kind: "Name", value: "first" },
          },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: {
            kind: "Variable",
            name: { kind: "Name", value: "after" },
          },
          type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "allFilms" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "first" },
                value: {
                  kind: "Variable",
                  name: { kind: "Name", value: "first" },
                },
              },
              {
                kind: "Argument",
                name: { kind: "Name", value: "after" },
                value: {
                  kind: "Variable",
                  name: { kind: "Name", value: "after" },
                },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "FragmentSpread",
                  name: { kind: "Name", value: "FilmsConnection" },
                },
              ],
            },
          },
        ],
      },
    },
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmItem" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "Film" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          { kind: "Field", name: { kind: "Name", value: "id" } },
          { kind: "Field", name: { kind: "Name", value: "title" } },
          { kind: "Field", name: { kind: "Name", value: "releaseDate" } },
          { kind: "Field", name: { kind: "Name", value: "producers" } },
        ],
      },
    },
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmsConnection" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "FilmsConnection" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "edges" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "node" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      {
                        kind: "FragmentSpread",
                        name: { kind: "Name", value: "FilmItem" },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: "Field",
            name: { kind: "Name", value: "pageInfo" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "hasNextPage" } },
                { kind: "Field", name: { kind: "Name", value: "endCursor" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<
  AllFilmsWithVariablesQueryQuery,
  AllFilmsWithVariablesQueryQueryVariables
>;
export const FilmDetailsDocument = {
  kind: "Document",
  definitions: [
    {
      kind: "OperationDefinition",
      operation: "query",
      name: { kind: "Name", value: "FilmDetails" },
      variableDefinitions: [
        {
          kind: "VariableDefinition",
          variable: {
            kind: "Variable",
            name: { kind: "Name", value: "filmId" },
          },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "ID" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: {
            kind: "Variable",
            name: { kind: "Name", value: "first" },
          },
          type: {
            kind: "NonNullType",
            type: { kind: "NamedType", name: { kind: "Name", value: "Int" } },
          },
        },
        {
          kind: "VariableDefinition",
          variable: {
            kind: "Variable",
            name: { kind: "Name", value: "after" },
          },
          type: { kind: "NamedType", name: { kind: "Name", value: "String" } },
        },
      ],
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "film" },
            arguments: [
              {
                kind: "Argument",
                name: { kind: "Name", value: "id" },
                value: {
                  kind: "Variable",
                  name: { kind: "Name", value: "filmId" },
                },
              },
            ],
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "id" } },
                { kind: "Field", name: { kind: "Name", value: "title" } },
                { kind: "Field", name: { kind: "Name", value: "director" } },
                { kind: "Field", name: { kind: "Name", value: "producers" } },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "openingCrawl" },
                },
                {
                  kind: "Field",
                  name: { kind: "Name", value: "characterConnection" },
                  arguments: [
                    {
                      kind: "Argument",
                      name: { kind: "Name", value: "first" },
                      value: {
                        kind: "Variable",
                        name: { kind: "Name", value: "first" },
                      },
                    },
                    {
                      kind: "Argument",
                      name: { kind: "Name", value: "after" },
                      value: {
                        kind: "Variable",
                        name: { kind: "Name", value: "after" },
                      },
                    },
                  ],
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      {
                        kind: "FragmentSpread",
                        name: {
                          kind: "Name",
                          value: "FilmCharactersConnection",
                        },
                      },
                    ],
                  },
                },
                { kind: "Field", name: { kind: "Name", value: "releaseDate" } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: "FragmentDefinition",
      name: { kind: "Name", value: "FilmCharactersConnection" },
      typeCondition: {
        kind: "NamedType",
        name: { kind: "Name", value: "FilmCharactersConnection" },
      },
      selectionSet: {
        kind: "SelectionSet",
        selections: [
          {
            kind: "Field",
            name: { kind: "Name", value: "edges" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                {
                  kind: "Field",
                  name: { kind: "Name", value: "node" },
                  selectionSet: {
                    kind: "SelectionSet",
                    selections: [
                      { kind: "Field", name: { kind: "Name", value: "id" } },
                      { kind: "Field", name: { kind: "Name", value: "name" } },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: "Field",
            name: { kind: "Name", value: "pageInfo" },
            selectionSet: {
              kind: "SelectionSet",
              selections: [
                { kind: "Field", name: { kind: "Name", value: "hasNextPage" } },
                { kind: "Field", name: { kind: "Name", value: "endCursor" } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<FilmDetailsQuery, FilmDetailsQueryVariables>;
