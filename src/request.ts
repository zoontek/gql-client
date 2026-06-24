import {
  BadStatusError,
  InvalidResponseError,
  NetworkError,
  parseGraphQLError,
  TimeoutError,
} from "./errors";
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
      controller.abort(new TimeoutError(url, timeout));
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
        throw new BadStatusError(response);
      }

      const json: JsonValue = await response.json().catch(() => null);

      if (isRecord(json)) {
        if ("errors" in json && Array.isArray(json.errors)) {
          throw json.errors.map(parseGraphQLError);
        }
        if ("data" in json && json.data != null) {
          return json.data as JsonValue;
        }
      }

      throw new InvalidResponseError(response);
    })
    .catch((error) => {
      if (
        Array.isArray(error) ||
        error instanceof BadStatusError ||
        error instanceof InvalidResponseError
      ) {
        throw error;
      }

      // Some runtimes reject an aborted fetch with a generic `AbortError`
      // instead of propagating the abort reason, so recover the `TimeoutError`
      // from the signal rather than misreporting a timeout as a network error.
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof TimeoutError
      ) {
        throw controller.signal.reason;
      }

      throw new NetworkError(url);
    })
    .finally(() => {
      clearTimeout(timer);
    });
};
