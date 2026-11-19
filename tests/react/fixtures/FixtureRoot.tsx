import { Suspense, useState, type ReactNode } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import type { Client } from "../../../src/client/client";
import { ClientProvider } from "../../../src/react/context";
import { createClient } from "../../shared";

const ErrorFallback = ({
  error,
  resetErrorBoundary,
}: FallbackProps): ReactNode => (
  <div>
    <pre data-testid="error">{(error as Error).message}</pre>

    <button data-testid="reset" onClick={resetErrorBoundary}>
      reset
    </button>
  </div>
);

export const FixtureRoot = ({
  client: getClient = () => createClient({ url: "/graphql" }),
  errorBoundary = false,
  children,
}: {
  client?: () => Client;
  errorBoundary?: boolean;
  children: ReactNode;
}): ReactNode => {
  const [client] = useState(getClient);

  const content = (
    <Suspense fallback={<div data-testid="loading">loading</div>}>
      {children}
    </Suspense>
  );

  return (
    <ClientProvider value={client}>
      {errorBoundary ? (
        <ErrorBoundary fallbackRender={ErrorFallback}>{content}</ErrorBoundary>
      ) : (
        content
      )}
    </ClientProvider>
  );
};
