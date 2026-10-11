import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  ProviderDriverKind,
  SubagentRuntimeId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { getProviderOptionDescriptors } from "@cafecode/shared/model";
import { getLocalizedProviderOptionDescriptors } from "./providerOptionPresentation";
import { localizeProviderSettingsField } from "./components/settings/providerSettingsPresentation";
import { DRIVER_OPTION_BY_VALUE } from "./components/settings/providerDriverMeta";
import {
  deriveProviderSettingsFields,
  type ProviderSettingsFieldModel,
} from "./components/settings/ProviderSettingsForm";
import { deriveChatActivityPresentation } from "./components/chat/chatActivity";
import { formatTimestamp, getTimestampFormatOptions } from "./timestampFormat";
import { nativeRetryWorkLogLabel } from "./codexRecovery";

describe("English-only renderer helper presentation", () => {
  it("keeps built-in settings values, constraints, defaults and ordering intact", () => {
    for (const definition of Object.values(DRIVER_OPTION_BY_VALUE)) {
      if (!definition) continue;
      for (const field of deriveProviderSettingsFields(definition)) {
        const localized = localizeProviderSettingsField(definition, field);
        expect(localized).toEqual(field);
        expect(localized.key).toBe(field.key);
        expect(localized.options?.map((option) => option.value)).toEqual(
          field.options?.map((option) => option.value),
        );
      }
    }
  });

  it("does not translate custom settings metadata even when its field key matches a built-in", () => {
    const base = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")]!;
    const custom = {
      ...base,
      settingsSchema: Schema.Struct({ binaryPath: Schema.optionalKey(Schema.String) }),
    };
    const field: ProviderSettingsFieldModel = {
      key: "binaryPath",
      label: "{private} User label",
      description: "Provider's arbitrary prose",
      control: "text",
      clearWhenEmpty: "omit",
    };
    expect(localizeProviderSettingsField(custom, field)).toBe(field);
    expect(localizeProviderSettingsField(base, { ...field, key: "__proto__" })).toEqual({
      ...field,
      key: "__proto__",
    });
  });

  it("localizes only Cafe's lost-capability escape and preserves native descriptor labels/options", () => {
    const caps = { optionDescriptors: [] };
    const selections = [{ id: "serviceTier", value: "removed-native-tier" }];
    expect(getLocalizedProviderOptionDescriptors({ caps, selections })).toEqual(
      getProviderOptionDescriptors({ caps, selections }),
    );
    const native = {
      optionDescriptors: [
        {
          id: "serviceTier",
          type: "select" as const,
          label: "{native} Tier",
          options: [{ id: "default", label: "{native} Standard" }],
        },
      ],
    };
    const result = getLocalizedProviderOptionDescriptors({
      caps: native,
      selections: [{ id: "serviceTier", value: "default" }],
    });
    expect(result[0]).toMatchObject({
      label: "{native} Tier",
      options: [{ id: "default", label: "{native} Standard" }],
      currentValue: "default",
    });
    expect(native.optionDescriptors[0]).not.toHaveProperty("currentValue");
  });

  it("uses full count messages without changing live-work counters or ownership", () => {
    const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000001");
    const base = {
      activities: [] as OrchestrationThreadActivity[],
      runtimeSession: { subagentRuntimeId: runtimeId, orchestrationStatus: "ready" as const },
      turnId: null,
      preparing: false,
      connecting: false,
      streaming: false,
      approvalCount: 0,
      questionCount: 0,
    };
    // The idle summary uses only the admitted synthetic received-work shape;
    // a foreign liveWork runtime must not create translated claims/counters.
    const absent = deriveChatActivityPresentation({
      ...base,
      running: false,
      liveWork: {
        runtimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000002"),
        agentCount: 100,
        taskCount: 100,
      },
    });
    expect(absent).toBeNull();
    const observed = deriveChatActivityPresentation({
      ...base,
      running: true,
      liveWork: { runtimeId, taskCount: 0, agentCount: 1 },
    });
    expect(observed?.label).toBe("Waiting for 1 agent…");
    expect(observed?.agentCount).toBe(1);
  });

  it("preserves native timestamp zone and explicit hour preference", () => {
    const instant = "2026-10-11T06:07:08.000Z";
    for (const preference of ["locale", "12-hour", "24-hour"] as const) {
      expect(formatTimestamp(instant, preference)).toBe(
        new Intl.DateTimeFormat(undefined, getTimestampFormatOptions(preference, true)).format(
          new Date(instant),
        ),
      );
    }
  });

  it("keeps retry counters as inert parameters rather than provider-native totals", () => {
    expect(
      nativeRetryWorkLogLabel({
        retrying: true,
        nativeRetry: { timing: "unknown", observedCount: 2, countLimited: true },
      }),
    ).toBe("Provider retry · 2+");
    expect(
      nativeRetryWorkLogLabel({
        retrying: true,
        nativeRetry: { timing: "unknown", observedCount: Number.NaN },
      }),
    ).toBe("Provider retry");
  });
});
