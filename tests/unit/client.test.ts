import { expect, test } from "bun:test";

import { Client } from "../../src/client/client";
import { ClientError } from "../../src/client/errors";
import { brandingQuery } from "./data";

test("ClientError has reason 'options' when requestOptions throws synchronously", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    requestOptions: () => {
      throw new Error("boom");
    },
  });

  const result = client.query(brandingQuery, {
    projectId: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "options" });
});

test("ClientError has reason 'options' when requestOptions rejects", async () => {
  const client = new Client({
    url: "http://localhost/graphql",
    schemaConfig: { interfaceToTypes: {} },
    requestOptions: async () => {
      throw new Error("boom");
    },
  });

  const result = client.mutate(brandingQuery, {
    projectId: "64060573-f0ec-4204-ad49-a3983497ada4",
  });

  await expect(result).rejects.toBeInstanceOf(ClientError);
  await expect(result).rejects.toMatchObject({ reason: "options" });
});
