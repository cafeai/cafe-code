import { describe, expect, it } from "vitest";

import { parseRequestEntries } from "./protocolMethodEntries.ts";

describe("parseRequestEntries", () => {
  it("retains Codex optional request parameters without treating undefined as a schema name", () => {
    const entries = parseRequestEntries(`
      export type ClientRequest =
        { "method": "initialize", id: RequestId, params: InitializeParams, }
        | { "method": "account/logout", id: RequestId, params: undefined, }
        | { "method": "account/usage/read", id: RequestId, params?: GetAccountTokenUsageParams | undefined, };
    `);

    expect(entries).toEqual([
      { method: "initialize", paramsType: "InitializeParams" },
      { method: "account/logout", paramsType: "undefined" },
      {
        method: "account/usage/read",
        paramsType: "GetAccountTokenUsageParams",
        paramsOptional: true,
      },
    ]);
  });
});
