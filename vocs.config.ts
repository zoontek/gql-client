import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "@zoontek/gql-client",
  description: "A simple, typesafe GraphQL client for React",
  basePath: "/gql-client",
  baseUrl: "https://zoontek.github.io/gql-client",
  renderStrategy: "full-static",
  srcDir: "docs",
  outDir: "docs/dist",
  sidebar: [
    {
      text: "Getting started",
      link: "/",
    },
  ],
  topNav: [
    {
      text: "GitHub",
      link: "https://github.com/zoontek/gql-client",
    },
  ],
});
