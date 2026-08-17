import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "@zoontek/gql-client",
  description: "A simple, typesafe GraphQL client for React",
  basePath: "/gql-client",
  baseUrl: "https://zoontek.github.io/gql-client",
  renderStrategy: "full-static",
  srcDir: "docs",
  outDir: "docs/dist",
  accentColor: "light-dark(#c026d3, #e879f9)",
  logoUrl: {
    dark: "/gql-client/logo-dark.svg",
    light: "/gql-client/logo-light.svg",
  },
  socials: [{ icon: "github", link: "https://github.com/zoontek/gql-client" }],
  editLink: {
    link: "https://github.com/zoontek/gql-client/edit/main/docs/:path",
    text: "Suggest changes to this page",
  },
  sidebar: [
    { text: "Getting started", link: "/" },
    {
      text: "Guides",
      items: [
        { text: "Queries", link: "/queries" },
        { text: "Mutations", link: "/mutations" },
        { text: "Caching", link: "/caching" },
        { text: "Pagination", link: "/pagination" },
        { text: "Authentication", link: "/authentication" },
        { text: "Refetching", link: "/refetching" },
        { text: "Server-side rendering", link: "/server-side-rendering" },
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
