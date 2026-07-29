import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { Client } from "../client/client";

const ClientContext = createContext(
  new Client({ url: "/graphql", schema: { interfaceToTypes: {} } }),
);

type Props = {
  children: ReactNode;
  value: Client;
};

export const ClientProvider = (props: Props): ReactElement =>
  createElement(ClientContext.Provider, props);

export const useClient = (): Client => useContext(ClientContext);
