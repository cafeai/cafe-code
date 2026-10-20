import { expect, it } from "@effect/vitest";
import type { ProviderSecurityInput, ProviderSecurityReport } from "@cafecode/contracts";
import { SubagentRuntimeId, ThreadId } from "@cafecode/contracts/baseSchemas";
import { ProviderInstanceId } from "@cafecode/contracts/providerInstance";
import * as Effect from "effect/Effect";
import { readOwnedProviderSecurity } from "./providerSecuritySubscription.ts";

const input: ProviderSecurityInput = {
  instanceId: ProviderInstanceId.make("axiom-personal"),
  threadId: ThreadId.make("chat"),
  runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001"),
  modelId: "model",
};
const report: ProviderSecurityReport = {
  runtimeId: input.runtimeId,
  modelId: input.modelId,
  providerId: "tinfoil",
  observedAt: "2026-10-13T00:00:00Z",
  attestation: { state: "unverified" },
  evidence: null,
  reply: { state: "none" },
};
const configuration = "c".repeat(64);
it.effect("reads only the admitted owner's configuration and fences returned coordinates", () =>
  Effect.gen(function* () {
    const authority = Effect.succeed({ key: "saved-owner", configuration });
    const result = yield* readOwnedProviderSecurity(input, authority, (key) => {
      expect(key).toBe(configuration);
      return Effect.succeed({ report });
    });
    expect(result.report).toEqual(report);
    for (const mismatch of [
      { ...report, modelId: "other" },
      { ...report, runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000002") },
    ])
      expect(
        (yield* readOwnedProviderSecurity(input, authority, () =>
          Effect.succeed({ report: mismatch }),
        )).report,
      ).toBeNull();
    expect(
      (yield* readOwnedProviderSecurity(input, Effect.succeed(undefined), () =>
        Effect.die("must not read a retired owner"),
      )).report,
    ).toBeNull();
  }),
);
it.effect(
  "discards a report if saved authority or provider configuration changes during the read",
  () =>
    Effect.gen(function* () {
      for (const changed of ["owner", "configuration"]) {
        let key = "before";
        let configured = configuration;
        const result = yield* readOwnedProviderSecurity(
          input,
          Effect.sync(() => ({ key, configuration: configured })),
          () =>
            Effect.sync(() => {
              if (changed === "owner") key = "after";
              else configured = "d".repeat(64);
              return { report };
            }),
        );
        expect(result.report).toBeNull();
      }
    }),
);
