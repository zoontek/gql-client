import { Option } from "@bloodyowl/boxed";

export const getCacheEntryKey = (json: unknown): Option<symbol> => {
  if (typeof json === "object" && json != null) {
    if ("__typename" in json && typeof json.__typename === "string") {
      const typename = json.__typename;

      if (
        typename === "Mutation" ||
        typename === "Query" ||
        typename === "Subscription"
      ) {
        return Option.Some(Symbol.for(typename));
      }

      if ("id" in json && typeof json.id === "string") {
        return Option.Some(Symbol.for(`${typename}<${json.id}>`));
      }
    }
  }
  return Option.None();
};
