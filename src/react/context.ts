import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";

import type { Client } from "../client/client";

const ClientContext = createContext<Client | null>(null);

type Props = {
  children: ReactNode;
  value: Client;
};

/** Makes `value` available to the hooks in `children`. */
export const ClientProvider = (props: Props): ReactElement =>
  createElement(ClientContext.Provider, props);

/**
 * Returns the `Client` from the nearest `ClientProvider`.
 * Throws if there is no `ClientProvider`.
 */
export const useClient = (): Client => {
  const client = useContext(ClientContext);

  if (client == null) {
    throw new Error(
      "GraphQL Client: no ClientProvider found. Wrap your app in a ClientProvider.",
    );
  }

  return client;
};
