import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  classifyGrokSandboxStartupStderr,
  GrokPermissionMode,
  GrokSandboxProfile,
  grokPermissionModeForRuntimeMode,
  grokSandboxProfileForRuntimeMode,
  readGrokAcpModelMetadata,
  resolveGrokAuthMethodId,
  resolveGrokAcpBaseModelId,
} from "./GrokAcpSupport.ts";

describe("resolveGrokAcpBaseModelId", () => {
  it("normalizes empty and custom Grok model ids", () => {
    expect(resolveGrokAcpBaseModelId(undefined)).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("   ")).toBe("grok-build");
    expect(resolveGrokAcpBaseModelId("  grok-test-custom-model  ")).toBe("grok-test-custom-model");
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it("maps every Cafe runtime mode to its explicit Grok sandbox", () => {
    expect(grokSandboxProfileForRuntimeMode("approval-required")).toBe("read-only");
    expect(grokSandboxProfileForRuntimeMode("auto-accept-edits")).toBe("workspace");
    expect(grokSandboxProfileForRuntimeMode("full-access")).toBe("off");
    expect(grokSandboxProfileForRuntimeMode("full-access", "plan")).toBe("read-only");
  });
  it("pins every Cafe runtime mode to the matching native Grok permission mode", () => {
    expect(grokPermissionModeForRuntimeMode("approval-required")).toBe("default");
    expect(grokPermissionModeForRuntimeMode("auto-accept-edits")).toBe("acceptEdits");
    expect(grokPermissionModeForRuntimeMode("full-access")).toBe("bypassPermissions");
    expect(grokPermissionModeForRuntimeMode("approval-required", "plan")).toBe("plan");
    expect(grokPermissionModeForRuntimeMode("auto-accept-edits", "auto")).toBe("auto");
  });
  it("passes the Cafe Code referrer through Grok OAuth env", () => {
    const spawn = buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project", {
      XAI_API_KEY: "secret",
      GROK_OAUTH2_REFERRER: "other-client",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/grok",
      args: [
        "--no-auto-update",
        "--sandbox",
        "read-only",
        "--permission-mode",
        "default",
        "agent",
        "--no-leader",
        "stdio",
      ],
      cwd: "/tmp/project",
      env: {
        XAI_API_KEY: "secret",
        GROK_OAUTH2_REFERRER: "cafe-code",
      },
    });
  });

  it("passes reasoning effort as a structured process argument", () => {
    const spawn = buildGrokAcpSpawnInput(
      { binaryPath: "grok" },
      "/tmp/project",
      {},
      GrokSandboxProfile.Off,
      GrokPermissionMode.Bypass,
      "xhigh",
    );
    expect(spawn.args).toEqual([
      "--no-auto-update",
      "--sandbox",
      "off",
      "--permission-mode",
      "bypassPermissions",
      "--reasoning-effort",
      "xhigh",
      "agent",
      "--no-leader",
      "stdio",
    ]);
  });

  it("sets GROK_HOME only when explicitly configured and maps the selected sandbox", () => {
    const spawn = buildGrokAcpSpawnInput(
      { binaryPath: "grok", homePath: "/private/grok" },
      "/tmp/project",
      {},
      GrokSandboxProfile.Workspace,
    );
    expect(spawn.args).toContain("workspace");
    expect(spawn.env?.GROK_HOME).toBe("/private/grok");
    expect(
      buildGrokAcpSpawnInput({ binaryPath: "grok", homePath: "" }, "/tmp", {}).env,
    ).not.toHaveProperty("GROK_HOME");
  });
});

describe("readGrokAcpModelMetadata", () => {
  it("decodes context capacity and canonical reasoning choices", () => {
    expect(
      readGrokAcpModelMetadata({
        modelId: "grok-4.6",
        name: "Grok 4.6",
        _meta: {
          totalContextTokens: 500_000,
          supportsReasoningEffort: true,
          reasoningEffort: "high",
          reasoningEfforts: [
            { id: "deep", value: "xhigh", label: "Deep", description: "Maximum reasoning" },
            { value: "high", label: "High" },
          ],
        },
      }),
    ).toEqual({
      totalContextTokens: 500_000,
      reasoningEffort: "high",
      reasoningEfforts: [
        {
          value: "xhigh",
          label: "Deep",
          description: "Maximum reasoning",
          isDefault: false,
        },
        { value: "high", label: "High", isDefault: true },
      ],
    });
  });

  it("ignores malformed metadata and uses Grok's documented effort fallback", () => {
    expect(
      readGrokAcpModelMetadata({
        modelId: "future",
        name: "Future",
        _meta: {
          totalContextTokens: -1,
          supportsReasoningEffort: true,
          reasoningEffort: "medium",
          reasoningEfforts: [],
        },
      }),
    ).toEqual({
      reasoningEffort: "medium",
      reasoningEfforts: [
        { value: "xhigh", label: "Extra High", isDefault: false },
        { value: "high", label: "High", isDefault: false },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "low", label: "Low", isDefault: false },
      ],
    });
  });
});

describe("classifyGrokSandboxStartupStderr", () => {
  it("fails protected profiles without retaining raw stderr details", () => {
    const raw = "warning: sandbox could not be applied: kernel rejected /private/secret/path";
    const failure = classifyGrokSandboxStartupStderr(GrokSandboxProfile.ReadOnly, raw);
    expect(failure?._tag).toBe("AcpRequestError");
    expect(failure?.message).not.toContain("/private/secret/path");
  });

  it("does not reinterpret warnings for explicit full access", () => {
    expect(
      classifyGrokSandboxStartupStderr(
        GrokSandboxProfile.Off,
        "warning: sandbox could not be applied: unavailable",
      ),
    ).toBeUndefined();
  });
});

describe("resolveGrokAuthMethodId", () => {
  const initialize = (ids: ReadonlyArray<string>) => ({
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  });

  it.effect("uses an API key only when the matching advertised method exists", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveGrokAuthMethodId(initialize(["cached_token", "xai.api_key"]), {
          XAI_API_KEY: "secret",
        }),
      ).toBe("xai.api_key");
      expect(
        yield* resolveGrokAuthMethodId(initialize(["cached_token"]), { XAI_API_KEY: "secret" }),
      ).toBe("cached_token");
    }),
  );

  it.effect("fails closed when no noninteractive advertised method is usable", () =>
    Effect.gen(function* () {
      const error = yield* resolveGrokAuthMethodId(initialize(["grok.com"]), {}).pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") expect(error.code).toBe(-32000);
    }),
  );
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["grok-mock-alt"]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
