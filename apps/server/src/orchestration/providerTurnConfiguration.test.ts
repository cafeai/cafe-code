import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  providerTurnConfigurationCommand,
  snapshotProviderTurnConfiguration,
} from "./providerTurnConfiguration.ts";

const instanceId = ProviderInstanceId.make("codex_work");
const threadId = ThreadId.make("thread-1");
const session: ProviderSession = {
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: instanceId,
  threadId,
  status: "ready",
  runtimeMode: "full-access",
  interactionMode: "default",
  model: "gpt-6.1-sol",
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
};
const request: ProviderSendTurnInput = {
  threadId,
  input: "private prompt",
  modelSelection: {
    instanceId,
    model: "gpt-6.1-sol",
    options: [
      { id: "reasoningEffort", value: "ultra" },
      { id: "fastMode", value: true },
      { id: "secret-option", value: "private-token" },
    ],
  },
  interactionMode: "plan",
};

describe("snapshotProviderTurnConfiguration", () => {
  it("freezes only known finite settings and cached presentation labels", () => {
    const result = snapshotProviderTurnConfiguration({
      session,
      request,
      instanceId,
      providerDisplayName: "Codex Work",
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null }],
      settingsSource: "submitted",
    });
    expect(result).toEqual({
      version: 1,
      provider: "codex",
      providerInstanceId: "codex_work",
      providerDisplayName: "Codex Work",
      model: "gpt-6.1-sol",
      modelDisplayName: "GPT-6.1 Sol",
      effort: "ultra",
      fastMode: true,
      runtimeMode: "full-access",
      interactionMode: "plan",
      settingsSource: "submitted",
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret-option|input|options/);
  });

  it("preserves explicit false and missing provider-owned defaults separately", () => {
    const off = snapshotProviderTurnConfiguration({
      session,
      request: {
        ...request,
        modelSelection: {
          instanceId,
          model: "gpt-6.1-sol",
          options: [{ id: "fastMode", value: false }],
        },
      },
      instanceId,
      settingsSource: "submitted",
    });
    expect(off?.fastMode).toBe(false);
    expect(off).not.toHaveProperty("effort");
    const defaults = snapshotProviderTurnConfiguration({
      session,
      request: { threadId, input: "private" },
      instanceId,
      settingsSource: "submitted",
    });
    expect(defaults?.model).toBe("gpt-6.1-sol");
    expect(defaults).not.toHaveProperty("fastMode");
    expect(defaults).not.toHaveProperty("effort");
  });

  it("uses the active session rather than a new composer model for steering", () => {
    const active = {
      ...session,
      model: "gpt-6-astra",
      modelSelection: {
        instanceId,
        model: "gpt-6-astra",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: false },
        ],
      },
    };
    const result = snapshotProviderTurnConfiguration({
      session: active,
      request,
      instanceId,
      settingsSource: "session",
    });
    expect(result).toMatchObject({
      model: "gpt-6-astra",
      effort: "high",
      fastMode: false,
      interactionMode: "default",
      settingsSource: "session",
    });
  });

  it("never borrows another account's selection", () => {
    expect(
      snapshotProviderTurnConfiguration({
        session,
        request: {
          ...request,
          modelSelection: {
            ...request.modelSelection!,
            instanceId: ProviderInstanceId.make("other"),
          },
        },
        instanceId,
        settingsSource: "submitted",
      }),
    ).not.toHaveProperty("effort");
    expect(
      snapshotProviderTurnConfiguration({
        session,
        request,
        instanceId: ProviderInstanceId.make("other"),
        settingsSource: "submitted",
      }),
    ).toBeUndefined();
  });

  it("retains known same-account inherited options only when no selection was submitted", () => {
    const inheritedSession = { ...session, modelSelection: request.modelSelection };
    const inherited = snapshotProviderTurnConfiguration({
      session: inheritedSession,
      request: { threadId },
      instanceId,
      settingsSource: "submitted",
    });
    expect(inherited).toMatchObject({ effort: "ultra", fastMode: true, settingsSource: "session" });
    const submittedMode = snapshotProviderTurnConfiguration({
      session: inheritedSession,
      request: { threadId, interactionMode: "plan" },
      instanceId,
      settingsSource: "submitted",
    });
    expect(submittedMode).toMatchObject({
      effort: "ultra",
      fastMode: true,
      interactionMode: "plan",
      settingsSource: "submitted",
    });
    const newSelection = snapshotProviderTurnConfiguration({
      session: inheritedSession,
      request: { threadId, modelSelection: { instanceId, model: "gpt-6-astra" } },
      instanceId,
      settingsSource: "submitted",
    });
    expect(newSelection).toMatchObject({ model: "gpt-6-astra", settingsSource: "submitted" });
    expect(newSelection).not.toHaveProperty("effort");
    expect(newSelection).not.toHaveProperty("fastMode");
    const foreignSession = snapshotProviderTurnConfiguration({
      session: {
        ...inheritedSession,
        modelSelection: {
          ...request.modelSelection!,
          instanceId: ProviderInstanceId.make("other"),
        },
      },
      request: { threadId },
      instanceId,
      settingsSource: "submitted",
    });
    expect(foreignSession).not.toHaveProperty("effort");
    expect(foreignSession).not.toHaveProperty("fastMode");
  });

  it("rejects oversized raw padded labels before normalization", () => {
    const result = snapshotProviderTurnConfiguration({
      session,
      request: {
        ...request,
        modelSelection: {
          instanceId,
          model: `${" ".repeat(200)}valid`,
          options: [{ id: "reasoningEffort", value: `${" ".repeat(80)}high` }],
        },
      },
      instanceId,
      providerDisplayName: `${" ".repeat(200)}Work`,
      settingsSource: "submitted",
    });
    expect(result?.providerDisplayName).toBe("Codex · codex_work");
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("effort");
  });

  it.each([
    ["claudeAgent", "effort", "max"],
    ["grok", "reasoningEffort", "high"],
    ["opencode", "variant", "deep"],
  ])("reads only %s's supported effort option id", (provider, key, effort) => {
    const selected = snapshotProviderTurnConfiguration({
      session: { ...session, provider: ProviderDriverKind.make(provider) },
      request: {
        ...request,
        modelSelection: {
          instanceId,
          model: "provider-model",
          options: [{ id: key, value: effort }],
        },
      },
      instanceId,
      settingsSource: "submitted",
    });
    expect(selected?.effort).toBe(effort);
  });

  it("falls back on unsafe names and omits unsafe model/effort labels", () => {
    for (const control of ["\n", "\u2028", "\u2029", "\u061c", "\u200e", "\u202e", "\u2066"]) {
      const result = snapshotProviderTurnConfiguration({
        session,
        request: {
          ...request,
          modelSelection: {
            instanceId,
            model: `model${control}`,
            options: [{ id: "reasoningEffort", value: `effort${control}` }],
          },
        },
        instanceId,
        providerDisplayName: `Work${control}`,
        settingsSource: "submitted",
      });
      expect(result?.providerDisplayName).toBe("Codex · codex_work");
      expect(result).not.toHaveProperty("model");
      expect(result).not.toHaveProperty("effort");
    }
  });
});

describe("providerTurnConfigurationCommand", () => {
  it("deduplicates one turn, distinguishes tuple boundaries, and omits all request content", () => {
    const configuration = snapshotProviderTurnConfiguration({
      session,
      request,
      instanceId,
      settingsSource: "submitted",
    })!;
    const input = {
      threadId,
      turnId: TurnId.make("turn-1"),
      configuration,
      createdAt: session.createdAt,
    };
    const first = providerTurnConfigurationCommand(input);
    const renamed = providerTurnConfigurationCommand({
      ...input,
      configuration: { ...configuration, providerDisplayName: "Renamed" },
    });
    expect(renamed.commandId).toBe(first.commandId);
    expect(JSON.stringify(first)).not.toContain("private prompt");
    expect(
      providerTurnConfigurationCommand({ ...input, turnId: TurnId.make("turn-2") }).commandId,
    ).not.toBe(first.commandId);
    expect(
      providerTurnConfigurationCommand({ ...input, threadId: ThreadId.make("thread-2") }).commandId,
    ).not.toBe(first.commandId);
  });
});
