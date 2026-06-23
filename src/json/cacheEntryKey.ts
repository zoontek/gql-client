export const getCacheEntryKey = (json: unknown): symbol | undefined => {
  if (typeof json === "object" && json != null) {
    if ("__typename" in json && typeof json.__typename === "string") {
      const typename = json.__typename;

      if (
        typename === "Mutation" ||
        typename === "Query" ||
        typename === "Subscription"
      ) {
        return Symbol.for(typename);
      }

      if ("id" in json && typeof json.id === "string") {
        return Symbol.for(`${typename}<${json.id}>`);
      }
    }
  }
  return undefined;
};
