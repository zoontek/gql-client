import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "react-error-boundary";
import { Client, ClientProvider } from "../src";
import { App } from "./components/App";
import schemaConfig from "./schemaConfig.json";

const client = new Client({
  url: "https://swapi-graphql.netlify.app/graphql",
  schemaConfig,
});

const Root = () => {
  return (
    <ClientProvider value={client}>
      <ErrorBoundary fallback={<h1>An error occured</h1>}>
        <Suspense fallback={<h1>Fetching…</h1>}>
          <App />
        </Suspense>
      </ErrorBoundary>
    </ClientProvider>
  );
};

const root = document.querySelector("#app");

if (root != null) {
  createRoot(root).render(<Root />);
}
