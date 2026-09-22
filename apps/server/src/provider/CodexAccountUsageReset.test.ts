import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import { requestCodexUsageReset } from "./CodexAccountUsageReset.ts";
import { ProviderUsageResetError } from "@cafecode/contracts";

function fixture(input: { outcome?: string; failRead?: boolean; apiKey?: boolean } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const client = {
    request: (method: string, params: unknown) =>
      Effect.suspend<unknown, CodexErrors.CodexAppServerRequestError, never>(() => {
        calls.push({ method, params });
        if (method === "account/read")
          return Effect.succeed({ account: { type: input.apiKey ? "apiKey" : "chatgpt" } });
        if (method === "account/rateLimitResetCredit/consume")
          return Effect.succeed({ outcome: input.outcome ?? "reset" });
        if (method === "account/rateLimits/read")
          return input.failRead
            ? Effect.fail(
                CodexErrors.CodexAppServerRequestError.internalError("private upstream error"),
              )
            : Effect.succeed({
                rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } },
                rateLimitResetCredits: { availableCount: 1 },
              });
        throw new Error(`Unexpected mocked method: ${method}`);
      }),
  } as unknown as CodexClient.CodexAppServerClientShape;
  return { client, calls };
}
const operation = {
  action: "redeem",
  identity: "private-identity",
  idempotencyKey: "same-attempt",
  creditId: "specific-credit",
} as const;

describe("Codex usage reset protocol (mocked JSON-RPC)", () => {
  it("only reads account and usage for a preview", async () => {
    const f = fixture();
    await Effect.runPromise(requestCodexUsageReset(f.client, { action: "preview" }));
    expect(f.calls.map((call) => call.method)).toEqual(["account/read", "account/rateLimits/read"]);
  });
  it.each(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"])(
    "preserves %s and fetches authoritative usage after consume",
    async (outcome) => {
      const f = fixture({ outcome });
      const response = await Effect.runPromise(requestCodexUsageReset(f.client, operation));
      expect(response.outcome).toBe(outcome);
      expect(response.rateLimits?.rateLimits.primary?.usedPercent).toBe(3);
      expect(f.calls).toEqual([
        { method: "account/read", params: {} },
        {
          method: "account/rateLimitResetCredit/consume",
          params: { idempotencyKey: "same-attempt", creditId: "specific-credit" },
        },
        { method: "account/rateLimits/read", params: undefined },
      ]);
    },
  );
  it("does not lose a confirmed result if its follow-up usage read fails", async () => {
    const f = fixture({ failRead: true });
    expect(await Effect.runPromise(requestCodexUsageReset(f.client, operation))).toEqual({
      outcome: "reset",
      rateLimits: null,
    });
  });
  it("refuses API-key accounts before consuming", async () => {
    const f = fixture({ apiKey: true });
    await expect(Effect.runPromise(requestCodexUsageReset(f.client, operation))).rejects.toThrow(
      "ChatGPT Codex account",
    );
    expect(f.calls).toHaveLength(1);
  });
  it("rechecks account identity immediately before dispatch and never spends after account churn", async () => {
    const f = fixture();
    let dispatched = false;
    await expect(
      Effect.runPromise(
        requestCodexUsageReset(
          f.client,
          {
            ...operation,
            onDispatch: () => {
              dispatched = true;
            },
          },
          Effect.fail(new ProviderUsageResetError({ message: "Account changed" })),
        ),
      ),
    ).rejects.toThrow("Account changed");
    expect(dispatched).toBe(false);
    expect(f.calls.map((call) => call.method)).toEqual(["account/read"]);
  });
});
