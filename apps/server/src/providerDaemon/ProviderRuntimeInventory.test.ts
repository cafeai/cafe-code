import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDaemonHealth,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import {
  summarizeProviderQualification,
  windowsSupervisorOwnershipMetadata,
} from "./ProviderRuntimeInventory.ts";

describe("Owner-local qualification diagnostics", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("synthetic-owner"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    checkedAt: "2026-10-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };

  it("counts unknown and reported pending independently without exposing identity or content", () => {
    const summary = summarizeProviderQualification([
      { ...provider, version: "0.159.2" },
      provider,
      {
        ...provider,
        probeDiagnostics: {
          attemptCount: 0,
          consecutiveInconclusiveCount: 0,
          lastOutcome: "pending",
          lastStartedAt: null,
          lastFinishedAt: null,
          lastDurationMs: null,
          periodicIntervalMs: null,
          periodicPhaseOffsetMs: null,
          nextScheduledAt: null,
        },
      },
    ]);
    assert.deepEqual(summary, { versionKnownCount: 1, versionUnknownCount: 2, pendingCount: 1 });
    assert.notInclude(JSON.stringify(summary), provider.instanceId);
    assert.deepEqual(summarizeProviderQualification([]), {
      versionKnownCount: 0,
      versionUnknownCount: 0,
      pendingCount: 0,
    });
  });

  it("preserves optional numeric evidence through health decoding without granting admission", () => {
    const health = {
      ok: true,
      mode: "provider-daemon",
      pid: 27,
      ppid: 1,
      version: "0.0.0-test",
      startedAt: "2026-10-10T00:00:00.000Z",
      activeSessionCount: 0,
      configuredInstanceCount: 3,
      eventCursor: 0,
    } as const;
    const decode = Schema.decodeUnknownSync(ProviderDaemonHealth);
    assert.isUndefined(decode(health).providerQualification);
    const summary = { versionKnownCount: 1, versionUnknownCount: 2, pendingCount: 1 };
    assert.deepEqual(
      decode({ ...health, providerQualification: summary }).providerQualification,
      summary,
    );
    for (const value of [-1, 0.5, "1", Number.POSITIVE_INFINITY]) {
      assert.throws(() =>
        decode({ ...health, providerQualification: { ...summary, pendingCount: value } }),
      );
    }
  });
});

describe("Windows upstream supervisor identity propagation", () => {
  const legacyHealth: ProviderDaemonHealth = {
    ok: true,
    mode: "provider-supervisor",
    pid: 27,
    ppid: 1,
    version: "0.0.0-test",
    startedAt: "2026-09-27T00:00:00.000Z",
    activeSessionCount: 0,
    configuredInstanceCount: 0,
    eventCursor: 0,
  };
  const identity = { pid: 27, creationTime100ns: "134348901321234567" };
  const generation = "9a90b48d-868f-4614-ae9c-66d50293d52b";

  it("carries the supervisor's own authenticated generation and identity on Windows", () => {
    assert.deepEqual(
      windowsSupervisorOwnershipMetadata(
        {
          ...legacyHealth,
          windowsProcessIdentity: identity,
          windowsOwnershipId: generation,
        },
        "win32",
      ),
      { windowsProcessIdentity: identity, windowsOwnershipId: generation },
    );
  });

  it("does not invent legacy authority or change POSIX health payloads", () => {
    assert.deepEqual(windowsSupervisorOwnershipMetadata(legacyHealth, "win32"), {});
    for (const platform of ["darwin", "linux"] as const) {
      assert.deepEqual(
        windowsSupervisorOwnershipMetadata(
          {
            ...legacyHealth,
            windowsProcessIdentity: identity,
            windowsOwnershipId: generation,
          },
          platform,
        ),
        {},
      );
    }
  });
});
