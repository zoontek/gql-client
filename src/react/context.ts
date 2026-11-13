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

/**
 * Makes `value` (a `Client` instance) available to `useQuery`, `useMutation`,
 * and the pagination hooks in `children`. Render this once near the root of
 * your app.
 *
 * @param props.value - The `Client` instance to expose.
 * @param props.children - The subtree that can use `useQuery`, `useMutation`,
 * and the pagination hooks.
 * @returns The provider element.
 */
export const ClientProvider = (props: Props): ReactElement =>
  createElement(ClientContext.Provider, props);

/**
 * Returns the `Client` from the nearest `ClientProvider`.
 *
 * @returns The `Client` instance.
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
