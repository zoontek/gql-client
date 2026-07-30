import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { Client } from "../client/client";

const ClientContext = createContext(
  new Client({ url: "/graphql", schemaConfig: { interfaceToTypes: {} } }),
);

type Props = {
  children: ReactNode;
  value: Client;
};

/**
 * Makes `value` (a `Client` instance) available to `useQuery`, `useMutation`,
 * and the pagination hooks in `children`. Render this once near the root of
 * your app.
 */
export const ClientProvider = (props: Props): ReactElement =>
  createElement(ClientContext.Provider, props);

/** Returns the `Client` from the nearest `ClientProvider`. */
export const useClient = (): Client => useContext(ClientContext);
