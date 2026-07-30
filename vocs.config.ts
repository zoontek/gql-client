import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "gql-client",
  description: "A simple, typesafe GraphQL client for React",
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
