import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@cafecode/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "runtimeSource",
      "binaryPath",
      "homePath",
      "shadowHomePath",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    const fields = deriveProviderSettingsFields(claude!);
    const runtimeSource = fields.find((field) => field.key === "runtimeSource");
    const launchArgs = fields.find((field) => field.key === "launchArgs");

    expect(runtimeSource).toMatchObject({
      label: "Runtime",
      description: "Choose the Claude CLI runtime used by this instance.",
      control: "select",
      defaultStringValue: "system",
      options: [
        {
          value: "system",
          label: "System CLI",
          description: "Use the provider CLI from PATH or the configured binary path.",
        },
        {
          value: "bundled",
          label: "Bundled runtime",
          description: "Use Cafe Code's managed Windows runtime and provider install.",
        },
      ],
    });
    expect(launchArgs).toMatchObject({
      label: "Launch arguments",
      description: "Additional CLI arguments passed on session start.",
      control: "text",
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    const launchArgs = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "launchArgs",
    );
    expect(launchArgs).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, launchArgs: "--verbose" },
      launchArgs!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits select fields when they are reset to their default value", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];
    expect(codex).toBeDefined();

    const runtimeSource = deriveProviderSettingsFields(codex!).find(
      (field) => field.key === "runtimeSource",
    );
    expect(runtimeSource).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, runtimeSource: "bundled" },
      runtimeSource!,
      "system",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
