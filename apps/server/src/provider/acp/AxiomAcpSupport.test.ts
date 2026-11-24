import * as ProviderDateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderAttestationEvidence,
  type ProviderAttestationEvidence as Evidence,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  AXIOM_CLIENT_CAPABILITIES,
  AXIOM_CLI_CLIENT_CAPABILITIES,
  axiomAccountKey,
  axiomConfigurationKey,
  axiomCreditBalance,
  applyAxiomSelection,
  axiomSpawnInput,
  makeAxiomBackgroundControl,
  makeAxiomControl,
  negotiateAxiom,
  validateAxiomEvidence,
} from "./AxiomAcpSupport.ts";
import { AxiomSettings, ProviderInstanceId } from "@cafecode/contracts";
import {
  AXIOM_CURRENT_INITIALIZE_RESPONSE,
  axiomContractInitializeResponse,
} from "../testUtils/axiomAcpContractFixture.ts";

export const evidenceFixture = (
  now = Math.floor(ProviderDateTime.toEpochMillis(ProviderDateTime.nowUnsafe()) / 1000),
): Evidence => ({
  status: { state: "verified" },
  providerId: "tinfoil",
  modelId: "test-model",
  attestationProtocol: "tinfoil-snp-sigstore-v1",
  e2eeProtocol: "tinfoil-ehbp-v1",
  e2eeEncryptionVersion: 1,
  trustPolicyVersion: "test-policy",
  verifiedAtUnixSeconds: now,
  hardExpiresAtUnixSeconds: now + 240,
  modelKeyFingerprint: "a".repeat(64),
  tlsSpkiFingerprint: "b".repeat(64),
  checks: [{ name: "SNP router", passed: true, detail: "Fixture quote checked" }],
  providerClaims: [],
});

describe("Axiom native protocol admission", () => {
  it.effect(
    "never retries an unsupported background probe with interactive credential access",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const attempts: boolean[] = [];
        const rejectingPeer = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) {
            return Effect.die(new Error("Expected a direct native probe command"));
          }
          attempts.push(command.args.includes("--no-keychain-ui"));
          return spawner.spawn(
            ChildProcess.make(process.execPath, ["-e", "process.exit(2)"], { shell: false }),
          );
        });
        const settings = Schema.decodeSync(AxiomSettings)({});
        const result = yield* makeAxiomBackgroundControl(
          settings,
          process.cwd(),
          undefined,
          "darwin",
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, rejectingPeer),
          Effect.scoped,
          Effect.exit,
        );
        expect(result._tag).toBe("Failure");
        expect(attempts).toEqual([true]);
        const foreground = yield* makeAxiomControl(settings, process.cwd()).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, rejectingPeer),
          Effect.scoped,
          Effect.exit,
        );
        expect(foreground._tag).toBe("Failure");
        expect(attempts).toEqual([true, false]);
        const otherPlatform = yield* makeAxiomBackgroundControl(
          settings,
          process.cwd(),
          undefined,
          "win32",
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, rejectingPeer),
          Effect.scoped,
          Effect.exit,
        );
        expect(otherPlatform._tag).toBe("Failure");
        expect(attempts).toEqual([true, false, false]);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("applies supported native defaults while retaining an explicit thinking choice", () =>
    Effect.gen(function* () {
      for (const [levels, explicit, expected] of [
        [["disabled", "enabled"], undefined, "enabled"],
        [["low", "medium", "high"], undefined, "medium"],
        [["low", "medium", "high"], "high", "high"],
        [[], undefined, undefined],
      ] as const) {
        const calls: Array<[string, string | boolean]> = [];
        yield* applyAxiomSelection(
          {
            setModel: (model) =>
              Effect.sync(() => {
                calls.push(["model", model]);
              }),
            setConfigOption: (id, value) =>
              Effect.sync(() => {
                calls.push([id, value]);
              }),
          },
          {
            instanceId: ProviderInstanceId.make("axiom"),
            model: "native-model",
            ...(explicit ? { options: [{ id: "thinkingLevel", value: explicit }] } : {}),
          },
          { thinkingLevels: levels },
        );
        expect(calls).toEqual([
          ["model", "native-model"],
          ...(expected ? [["thinking", expected]] : []),
        ]);
      }
    }),
  );
  it.effect(
    "admits the current native contract independently of Cafe's requested capabilities",
    () =>
      Effect.gen(function* () {
        const extension = yield* negotiateAxiom(AXIOM_CURRENT_INITIALIZE_RESPONSE);
        expect(extension.features.activity).toBe(2);
        expect(extension.features.desktopMcp).toBe(2);
        expect(extension.features.billing).toBe(7);
        expect(extension.features.commandInvocation).toBe(1);
        yield* negotiateAxiom({
          ...AXIOM_CURRENT_INITIALIZE_RESPONSE,
          agentInfo: { name: "axiomcli", version: "9.99.0" },
        });
        yield* negotiateAxiom(
          axiomContractInitializeResponse("10000000-0000-4000-8000-000000000002", "cli"),
          "cli",
        );
      }),
  );
  it.effect("admits only the reviewed compatible activity and desktop MCP versions", () =>
    Effect.gen(function* () {
      for (const activity of [1, 2]) {
        for (const desktopMcp of [1, 2]) {
          const response = axiomContractInitializeResponse("10000000-0000-4000-8000-000000000001");
          response.agentCapabilities._meta.axiom.features.activity = activity;
          response.agentCapabilities._meta.axiom.features.desktopMcp = desktopMcp;
          yield* negotiateAxiom(response);
        }
      }
    }),
  );
  it.effect(
    "rejects absent or unreviewed required contracts with the exact local feature name",
    () =>
      Effect.gen(function* () {
        for (const [feature, version] of [
          ["activity", 0],
          ["activity", 3],
          ["desktopMcp", 0],
          ["desktopMcp", 3],
          ["securityEvidence", 3],
          ["securityEvidence", 5],
          ["account", 1],
          ["attachments", 1],
          ["timeline", 1],
          ["commandInvocation", 0],
          ["commandInvocation", 2],
        ] as const) {
          const response = axiomContractInitializeResponse("10000000-0000-4000-8000-000000000001");
          const features: Record<string, number> = response.agentCapabilities._meta.axiom.features;
          features[feature] = version;
          const failure = yield* negotiateAxiom(response).pipe(Effect.flip);
          expect(failure.message).toContain(`Unsupported Axiom ${feature} contract ${version}`);
        }
        const missing = axiomContractInitializeResponse("10000000-0000-4000-8000-000000000001");
        const features: Record<string, number> = missing.agentCapabilities._meta.axiom.features;
        delete features.commandInvocation;
        expect((yield* negotiateAxiom(missing).pipe(Effect.result))._tag).toBe("Failure");
      }),
  );
  it.effect("rejects unsupported protocol families and malformed native runtime identities", () =>
    Effect.gen(function* () {
      for (const invalid of [
        {
          protocolVersion: 2,
          extensionVersion: "0.2",
          runtimeId: "10000000-0000-4000-8000-000000000001",
        },
        {
          protocolVersion: 1,
          extensionVersion: "1.0",
          runtimeId: "10000000-0000-4000-8000-000000000001",
        },
        { protocolVersion: 1, extensionVersion: "0.2", runtimeId: "not-a-native-runtime" },
      ]) {
        const response = axiomContractInitializeResponse(invalid.runtimeId);
        response.protocolVersion = invalid.protocolVersion;
        response.agentCapabilities._meta.axiom.protocolVersion = invalid.extensionVersion;
        expect((yield* negotiateAxiom(response).pipe(Effect.result))._tag).toBe("Failure");
      }
    }),
  );
  it.effect("ignores an unknown optional advertisement without granting its use", () =>
    Effect.gen(function* () {
      const response = axiomContractInitializeResponse("10000000-0000-4000-8000-000000000001");
      const features: Record<string, number> = response.agentCapabilities._meta.axiom.features;
      features.futureOptionalFeature = 1;
      yield* negotiateAxiom(response);
      expect("futureOptionalFeature" in AXIOM_CLIENT_CAPABILITIES._meta.axiom.features).toBe(false);
    }),
  );
  it("uses structured native argv, including executable paths with spaces", () => {
    const settings = Schema.decodeSync(AxiomSettings)({
      binaryPath: "/Applications/Example App/bin/axiomcli",
    });
    expect(axiomSpawnInput(settings, process.cwd(), { EXAMPLE: "$(inert)" })).toEqual({
      command: settings.binaryPath,
      args: ["acp", "--frontend", "desktop-chat"],
      cwd: process.cwd(),
      env: { EXAMPLE: "$(inert)" },
    });
    expect(axiomAccountKey("private-account")).toMatch(/^[a-f0-9]{64}$/);
    expect(axiomAccountKey("private-account")).not.toContain("private-account");
    expect(axiomSpawnInput(settings, process.cwd(), undefined, "cli").args).toEqual([
      "acp",
      "--frontend",
      "cli",
    ]);
    expect(
      axiomSpawnInput(settings, process.cwd(), undefined, "desktop-chat", "forbidden").args,
    ).toEqual(["acp", "--frontend", "desktop-chat", "--no-keychain-ui"]);
  });
  it.effect("requires desktop contracts for chats while allowing isolated CLI helpers", () =>
    Effect.gen(function* () {
      const response = {
        protocolVersion: 1,
        agentCapabilities: {
          _meta: {
            axiom: {
              ...AXIOM_CLI_CLIENT_CAPABILITIES._meta.axiom,
              runtimeInstanceId: "10000000-0000-4000-8000-000000000001",
            },
          },
        },
      };
      expect((yield* negotiateAxiom(response).pipe(Effect.result))._tag).toBe("Failure");
      yield* negotiateAxiom(response, "cli");
    }),
  );
  it("admits the actual Tinfoil scope without inventing a relay lease", () => {
    const evidence = evidenceFixture(1000);
    expect(
      validateAxiomEvidence({ status: { state: "verified" }, evidence }, "test-model", 1001),
    ).toEqual(evidence);
    expect(Schema.is(ProviderAttestationEvidence)(evidence)).toBe(true);
  });
  it("commits effective executable/environment values without presentation flags and preserves microUSD", () => {
    const key = axiomConfigurationKey({}, [
      { name: "PRIVATE", value: "secret-value", sensitive: true },
      { name: "ORDER", value: "second" },
    ]);
    expect(key).toEqual(
      axiomConfigurationKey({ enabled: false }, [
        { name: "ORDER", value: "old" },
        { name: "PRIVATE", value: "secret-value", sensitive: false },
        { name: "ORDER", value: "second" },
      ]),
    );
    expect(key).not.toContain("secret-value");
    expect(key).not.toEqual(
      axiomConfigurationKey({ binaryPath: "other-cli" }, [
        { name: "PRIVATE", value: "secret-value" },
        { name: "ORDER", value: "second" },
      ]),
    );
    expect(axiomCreditBalance(1000001)).toBe("1.000001");
    expect(axiomCreditBalance(-1)).toBe("-0.000001");
    expect(axiomCreditBalance(Number.MAX_SAFE_INTEGER)).toBe("9007199254.740991");
  });
  it("rejects wrong model, expiry, future verification and unregistered protocols", () => {
    const evidence = evidenceFixture(1000);
    for (const invalid of [
      { ...evidence, modelId: "another-model" },
      { ...evidence, hardExpiresAtUnixSeconds: 1001 },
      { ...evidence, verifiedAtUnixSeconds: 1200 },
      { ...evidence, e2eeProtocol: "tls-only" },
      { ...evidence, checks: [{ name: "SNP router", passed: false, detail: "Failure" }] },
    ])
      expect(() =>
        validateAxiomEvidence(
          { status: { state: "verified" }, evidence: invalid },
          "test-model",
          1001,
        ),
      ).toThrow();
  });
  it("allows only the exact explicitly degraded NEAR posture", () => {
    const evidence: Evidence = {
      ...evidenceFixture(1000),
      status: { state: "degraded" },
      providerId: "near",
      attestationProtocol: "near-tdx-nvidia-v2",
      e2eeProtocol: "near-v3",
      e2eeEncryptionVersion: 2,
      attestationGeneration: 1,
      checks: [
        { name: "Intel TDX", passed: false, detail: "OutOfDate" },
        { name: "NVIDIA", passed: true, detail: "GPU checked" },
      ],
    };
    expect(
      validateAxiomEvidence({ status: { state: "degraded" }, evidence }, "test-model", 1001),
    ).toEqual(evidence);
    expect(() =>
      validateAxiomEvidence({ status: { state: "verified" }, evidence }, "test-model", 1001),
    ).toThrow();
    expect(() =>
      validateAxiomEvidence(
        {
          status: { state: "degraded" },
          evidence: {
            ...evidence,
            checks: [...evidence.checks, { name: "GPU", passed: false, detail: "Revoked" }],
          },
        },
        "test-model",
        1001,
      ),
    ).toThrow();
    expect(
      validateAxiomEvidence({ status: { state: "outdated" }, evidence: null }, "test-model", 1001),
    ).toBeNull();
  });
});
