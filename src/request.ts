import { parseGraphQLError } from "./errors";
import type { JsonValue } from "./types";
import { isRecord } from "./utils";

export class NetworkError extends Error {
  url: string;
  constructor(url: string) {
    super(`Request to ${url} failed`);
    Object.setPrototypeOf(this, NetworkError.prototype);
    this.name = "NetworkError";
    this.url = url;
  }
}

export class TimeoutError extends Error {
  url: string;
  timeout: number | undefined;
  constructor(url: string, timeout?: number) {
    if (timeout == undefined) {
      super(`Request to ${url} timed out`);
    } else {
      super(`Request to ${url} timed out (> ${timeout}ms)`);
    }
    Object.setPrototypeOf(this, TimeoutError.prototype);
    this.name = "TimeoutError";
    this.url = url;
    this.timeout = timeout;
  }
}

export class BadStatusError extends Error {
  response: Response;

  constructor(response: Response) {
    super(`Request to ${response.url} gave status ${response.status}`);
    Object.setPrototypeOf(this, BadStatusError.prototype);
    this.name = "BadStatusError";
    this.response = response;
  }
}

export class InvalidResponseError extends Error {
  response: unknown;
  constructor(response: unknown) {
    super("Received an invalid GraphQL response");
    Object.setPrototypeOf(this, InvalidResponseError.prototype);
    this.name = "InvalidResponseError";
    this.response = response;
  }
}

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
        error instanceof InvalidResponseError ||
        error instanceof TimeoutError
      ) {
        throw error;
      }

      throw new NetworkError(url);
    })
    .finally(() => {
      clearTimeout(timer);
    });
};
