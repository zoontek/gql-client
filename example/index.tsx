import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Client, ClientContext } from "../src";
import { App } from "./components/App";
import schemaConfig from "./schema.json";

const client = new Client({
  schemaConfig,
  url: "https://swapi-graphql.netlify.app/graphql",
  headers: {
    "Content-Type": "application/json",
  },
});

const Root = () => {
  return (
    <ClientContext.Provider value={client}>
      <Suspense fallback={<h1>Loading…</h1>}>
        <App />
      </Suspense>
    </ClientContext.Provider>
  );
};

const root = document.querySelector("#app");

if (root != null) {
  createRoot(root).render(<Root />);
}
