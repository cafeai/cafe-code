import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { DEBUG_PROVIDER_SUMMARY_LIMIT, summarizeProviderDebugFleet } from "./providerDebugSummary";

function providerFixture(index: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`instance-${String(index).padStart(3, "0")}`),
    driver: ProviderDriverKind.make(index % 2 === 0 ? "codex" : "claudeAgent"),
    displayName: `Provider ${index}`,
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: {
      status: "authenticated",
      email: "secret-account@example.test",
      label: "sensitive account label",
    },
    checkedAt: "2026-08-27T01:00:00.000Z",
    message: "provider command failed under /private/secret/path",
    unavailableReason: "missing binary at /private/secret/path",
    models: [
      {
        slug: "secret-model-id",
        name: "Secret model",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [{ name: "secret-command", description: "secret command details" }],
    skills: [
      {
        name: "secret-skill",
        description: "secret skill details",
        path: "/private/secret/skill",
        enabled: true,
      },
    ],
    probeDiagnostics: {
      attemptCount: 4,
      consecutiveInconclusiveCount: 1,
      lastOutcome: "inconclusive",
      lastStartedAt: "2026-08-27T00:59:59.000Z",
      lastFinishedAt: "2026-08-27T01:00:00.000Z",
      lastDurationMs: 1_000,
      periodicIntervalMs: 300_000,
      periodicPhaseOffsetMs: index,
      nextScheduledAt: "2026-08-27T01:05:00.000Z",
    },
    updateState: {
      status: "failed",
      startedAt: "2026-08-27T00:50:00.000Z",
      finishedAt: "2026-08-27T00:51:00.000Z",
      message: "failed while reading /private/secret/path",
      output: "npm_TOKEN=secret-package-manager-output",
    },
  };
}

describe("summarizeProviderDebugFleet", () => {
  it("keeps only allowlisted operational fields and omits sensitive provider content", () => {
    const summary = summarizeProviderDebugFleet([providerFixture(2)]);

    expect(summary).toEqual({
      totalCount: 1,
      includedCount: 1,
      omittedCount: 0,
      limit: DEBUG_PROVIDER_SUMMARY_LIMIT,
      instances: [
        {
          instanceId: "instance-002",
          driver: "codex",
          enabled: true,
          installed: true,
          version: "1.2.3",
          status: "ready",
          availability: "available",
          checkedAt: "2026-08-27T01:00:00.000Z",
          update: {
            status: "failed",
            startedAt: "2026-08-27T00:50:00.000Z",
            finishedAt: "2026-08-27T00:51:00.000Z",
          },
          probe: {
            attemptCount: 4,
            consecutiveInconclusiveCount: 1,
            lastOutcome: "inconclusive",
            lastStartedAt: "2026-08-27T00:59:59.000Z",
            lastFinishedAt: "2026-08-27T01:00:00.000Z",
            lastDurationMs: 1_000,
            periodicIntervalMs: 300_000,
            periodicPhaseOffsetMs: 2,
            nextScheduledAt: "2026-08-27T01:05:00.000Z",
          },
        },
      ],
    });

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("Provider 2");
    expect(serialized).not.toContain("secret-account");
    expect(serialized).not.toContain("sensitive account");
    expect(serialized).not.toContain("/private/secret/path");
    expect(serialized).not.toContain("secret-package-manager-output");
    expect(serialized).not.toContain("secret-model-id");
    expect(serialized).not.toContain("secret-command");
    expect(serialized).not.toContain("secret-skill");
  });

  it("sorts instances deterministically and bounds fleet cardinality", () => {
    const providers = Array.from({ length: DEBUG_PROVIDER_SUMMARY_LIMIT + 3 }, (_, index) =>
      providerFixture(DEBUG_PROVIDER_SUMMARY_LIMIT + 2 - index),
    );

    const summary = summarizeProviderDebugFleet(providers);

    expect(summary.includedCount).toBe(DEBUG_PROVIDER_SUMMARY_LIMIT);
    expect(summary.omittedCount).toBe(3);
    expect(summary.instances[0]?.instanceId).toBe("instance-000");
    expect(summary.instances.at(-1)?.instanceId).toBe(
      `instance-${String(DEBUG_PROVIDER_SUMMARY_LIMIT - 1).padStart(3, "0")}`,
    );
  });
});
