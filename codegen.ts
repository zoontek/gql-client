import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "https://swapi-graphql.netlify.app/graphql",
  documents: ["example/components/**/*.tsx"],
  generates: {
    "./example/gql/": {
      preset: "client",
      config: {
        useTypeImports: true,
      },
    },
  },
  hooks: {
    afterAllFileWrite: ["oxfmt"],
  },
};

export default config;
