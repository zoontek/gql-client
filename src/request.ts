import { ClientError, parseGraphQLError } from "./errors";
import type { JsonValue } from "./types";
import { isRecord } from "./utils";

type Config = {
  url: string;
  body?: BodyInit | null;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
  timeout?: number | undefined;
};

export const makeRequest = async ({
  url,
  body = null,
  credentials = "same-origin",
  headers = {},
  timeout = 10000,
}: Config): Promise<JsonValue> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (Number.isFinite(timeout) && timeout >= 0) {
    timer = setTimeout(() => {
      controller.abort(ClientError.timeout(url, timeout));
    }, timeout);
  }

  return fetch(url, {
    body,
    cache: "no-store",
    credentials,
    method: "POST",
    signal: controller.signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw ClientError.httpStatus(response);
      }

      const json: JsonValue = await response.json().catch(() => null);

      if (isRecord(json)) {
        if ("errors" in json && Array.isArray(json.errors)) {
          throw ClientError.graphql(
            url,
            response,
            json.errors.map(parseGraphQLError),
          );
        }

        if ("data" in json && json.data != null) {
          return json.data as JsonValue;
        }
      }

      throw ClientError.malformedResponse(url, response);
    })
    .catch((error) => {
      if (error instanceof ClientError) {
        throw error;
      }

      throw ClientError.network(url);
    })
    .finally(() => {
      clearTimeout(timer);
    });
};
