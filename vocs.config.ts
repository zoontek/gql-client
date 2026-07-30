import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "@zoontek/gql-client",
  description: "A simple, typesafe GraphQL client for React",
  basePath: "/gql-client",
  baseUrl: "https://zoontek.github.io/gql-client",
  renderStrategy: "full-static",
  srcDir: "docs",
  outDir: "docs/dist",
  topNav: [{ text: "GitHub", link: "https://github.com/zoontek/gql-client" }],
  sidebar: [
    { text: "Getting started", link: "/" },
    {
      text: "Guides",
      items: [
        { text: "Caching", link: "/caching" },
        { text: "Pagination", link: "/pagination" },
      ],
    },
    {
      text: "Hooks",
      items: [
        { text: "useQuery", link: "/use-query" },
        { text: "useMutation", link: "/use-mutation" },
        { text: "useForwardPagination", link: "/use-forward-pagination" },
        { text: "useBackwardPagination", link: "/use-backward-pagination" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Client", link: "/client" },
        { text: "Errors", link: "/errors" },
      ],
    },
  ],
});
