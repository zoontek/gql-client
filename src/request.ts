import { Future, Option, Result } from "@swan-io/boxed";

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

export class CanceledError extends Error {
  constructor() {
    super();
    Object.setPrototypeOf(this, CanceledError.prototype);
    this.name = "CanceledError";
  }
}

export class BadStatusError extends Error {
  url: string;
  status: number;
  response: unknown;
  constructor(url: string, status: number, response?: unknown) {
    super(`Request to ${url} gave status ${status}`);
    Object.setPrototypeOf(this, BadStatusError.prototype);
    this.name = "BadStatusError";
    this.url = url;
    this.status = status;
    this.response = response;
  }
}

export const badStatusToError = <T>(
  response: Response<T>,
): Result<Response<T>, BadStatusError> => {
  return response.ok
    ? Result.Ok(response)
    : Result.Error(
        new BadStatusError(
          response.url,
          response.status,
          response.response.toUndefined(),
        ),
      );
};

export class EmptyResponseError extends Error {
  url: string;
  constructor(url: string) {
    super(`Request to ${url} gave an empty response`);
    Object.setPrototypeOf(this, EmptyResponseError.prototype);
    this.name = "EmptyResponseError";
    this.url = url;
  }
}

export const emptyToError = <T>(response: Response<T>) => {
  return response.response.toResult(new EmptyResponseError(response.url));
};

// TODO: use RequestInit | () => RequestInit (similar to urql)
type Config = {
  body: BodyInit | null;
  credentials?: RequestCredentials;
  headers: Record<string, string>;
  mode?: RequestMode; // not mapped yet
  timeout?: number; // not mapped yet
  url: string;
};

type Response<T> = {
  status: number;
  ok: boolean;
  response: Option<T>;
  url: string;
  headers: Headers;
};

const resolvedPromise = Promise.resolve();

export const request = ({
  body,
  credentials = "same-origin",
  headers,
  mode = "cors",
  timeout,
  url,
}: Config): Future<Result<Response<unknown>, NetworkError | TimeoutError>> => {
  return Future.make<Result<Response<unknown>, NetworkError | TimeoutError>>(
    (resolve) => {
      const controller = new AbortController();

      if (timeout) {
        setTimeout(() => {
          controller.abort(new TimeoutError(url, timeout));
        }, timeout);
      }

      const init = async (): Promise<Response<unknown>> => {
        const res = await fetch(url, {
          body,
          cache: "no-store",
          credentials,
          headers,
          method: "POST",
          mode,
          signal: controller.signal,
        });

        let payload;

        try {
          payload = Option.Some(await res.json());
        } catch {
          payload = Option.None();
        }

        return {
          url,
          status: res.status,
          ok: res.ok,
          headers: res.headers,
          response: payload,
        };
      };

      init().then(
        (response) => resolve(Result.Ok(response)),
        (error) => {
          if (error instanceof CanceledError) {
            return resolvedPromise;
          }
          if (error instanceof TimeoutError) {
            resolve(Result.Error(error));
            return resolvedPromise;
          }
          resolve(Result.Error(new NetworkError(url)));
          return resolvedPromise;
        },
      );

      return () => {
        controller.abort(new CanceledError());
      };
    },
  );
};
