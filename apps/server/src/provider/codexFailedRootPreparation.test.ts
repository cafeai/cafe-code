import { expect, it } from "vitest";
import { ThreadId, TurnId, SubagentRuntimeId, ProviderInstanceId } from "@cafecode/contracts";
import {
  codexFailedRootPreparationCommitment,
  newCodexFailedRootPreparationSecret,
  sameCodexFailedRootPreparationSecret,
} from "./codexFailedRootPreparation.ts";

it("validates fixed secret shape without coercion or a trailing newline", () => {
  const secret = newCodexFailedRootPreparationSecret();
  expect(secret.length).toBe(64);
  expect(sameCodexFailedRootPreparationSecret(secret, secret)).toBe(true);
  expect(sameCodexFailedRootPreparationSecret(secret, `${secret}\n`)).toBe(false);
  expect(sameCodexFailedRootPreparationSecret(secret, "f".repeat(63))).toBe(false);
  expect(sameCodexFailedRootPreparationSecret(secret, undefined)).toBe(false);
  const trap = {
    toString() {
      throw new Error("must not coerce");
    },
  };
  expect(sameCodexFailedRootPreparationSecret(trap as unknown as string, secret)).toBe(false);
});

it("commits the full private request, prior history/account and immutable attempt", () => {
  const request = {
    threadId: ThreadId.make("recovery-commitment-thread"),
    input: "Synthetic continuation",
    allowActiveTurnSteerFallback: false,
    expectedFailedRoot: {
      turnId: TurnId.make("failed-root"),
      providerThreadId: "private-synthetic-history",
      subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000001"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      observedAt: "2026-10-28T00:00:00.000Z",
      restartSession: true as const,
    },
  };
  const digest = codexFailedRootPreparationCommitment("immutable-attempt", request);
  for (const changed of [
    { ...request, input: "Changed continuation" },
    { ...request, attachments: [] },
    {
      ...request,
      expectedFailedRoot: { ...request.expectedFailedRoot, providerThreadId: "other-history" },
    },
    {
      ...request,
      expectedFailedRoot: {
        ...request.expectedFailedRoot,
        providerInstanceId: ProviderInstanceId.make("other-account"),
      },
    },
  ])
    expect(codexFailedRootPreparationCommitment("immutable-attempt", changed)).not.toBe(digest);
  expect(codexFailedRootPreparationCommitment("other-attempt", request)).not.toBe(digest);
  expect(
    codexFailedRootPreparationCommitment("immutable-attempt", {
      ...request,
      preparedFailedRootRecovery: {
        attemptId: "immutable-attempt",
        preparationSequence: 0,
        requestCommitment: digest,
        permit: newCodexFailedRootPreparationSecret(),
      },
    }),
  ).toBe(digest);
});
