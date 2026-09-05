import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@cafecode/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  ProviderSettingsForm,
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigNumber,
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
      "maxConcurrentSubagents",
      "autoCompactTokenLimit",
    ]);
  });

  it("derives the bounded Codex subagent concurrency field as an optional override", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];
    expect(codex).toBeDefined();

    const field = deriveProviderSettingsFields(codex!).find(
      (candidate) => candidate.key === "maxConcurrentSubagents",
    );

    expect(field).toMatchObject({
      key: "maxConcurrentSubagents",
      control: "number",
      placeholder: "Provider default",
      step: 1,
      minimum: 1,
      maximum: 64,
      integerOnly: true,
    });
    expect(field?.defaultNumberValue).toBeUndefined();
  });

  it("renders numeric maximum constraints and associates descriptive help with the input", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];
    expect(codex).toBeDefined();

    const markup = renderToStaticMarkup(
      createElement(ProviderSettingsForm, {
        definition: codex!,
        value: undefined,
        idPrefix: "provider-instance-codex",
        variant: "dialog",
        onChange: () => undefined,
      }),
    );

    expect(markup).toMatch(
      /<input[^>]*id="provider-instance-codex-maxConcurrentSubagents"[^>]*type="number"[^>]*step="1"[^>]*min="1"[^>]*max="64"[^>]*aria-describedby="provider-instance-codex-maxConcurrentSubagents-description"[^>]*>/,
    );
    expect(markup).toContain('placeholder="Provider default"');
    expect(markup).toContain('id="provider-instance-codex-maxConcurrentSubagents-description"');
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

  it("exposes Grok Build as Early Access with only structured launch settings", () => {
    const grok = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("grok")];
    expect(grok).toMatchObject({ label: "Grok Build", badgeLabel: "Early Access" });
    expect(deriveProviderSettingsFields(grok!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
    ]);
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

  it("sources the optional Codex auto-compact override as a labeled numeric field", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];
    expect(codex).toBeDefined();

    const field = deriveProviderSettingsFields(codex!).find(
      (candidate) => candidate.key === "autoCompactTokenLimit",
    );

    expect(field).toMatchObject({
      label: "Auto-compact override",
      description:
        "Optional token threshold override. Leave blank to use Codex app-server's model-specific automatic compaction policy.",
      control: "number",
      step: 1_000,
      minimum: 1,
      integerOnly: true,
    });
    expect(field?.defaultNumberValue).toBeUndefined();
  });

  it("stores valid numeric field input as a number", () => {
    const field = {
      key: "autoCompactTokenLimit",
      control: "number",
      label: "Auto-compact token limit",
      clearWhenEmpty: "omit",
      minimum: 1,
      integerOnly: true,
    } as const;

    expect(nextProviderConfigWithFieldValue({ forkOwned: 1 }, field, "150000")).toEqual({
      forkOwned: 1,
      autoCompactTokenLimit: 150_000,
    });
  });

  it("stores a valid bounded Codex subagent concurrency override", () => {
    const field = {
      key: "maxConcurrentSubagents",
      control: "number",
      label: "Maximum concurrent subagents",
      clearWhenEmpty: "omit",
      step: 1,
      minimum: 1,
      maximum: 64,
      integerOnly: true,
    } as const;

    expect(nextProviderConfigWithFieldValue({ forkOwned: 1 }, field, "12")).toEqual({
      forkOwned: 1,
      maxConcurrentSubagents: 12,
    });
  });

  it("omits the Codex subagent concurrency override when the input is cleared", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];
    expect(codex).toBeDefined();

    const field = deriveProviderSettingsFields(codex!).find(
      (candidate) => candidate.key === "maxConcurrentSubagents",
    );
    expect(field).toBeDefined();

    expect(
      nextProviderConfigWithFieldValue({ forkOwned: 1, maxConcurrentSubagents: 12 }, field!, ""),
    ).toEqual({ forkOwned: 1 });
  });

  it("clears numeric fields when the input is emptied", () => {
    const field = {
      key: "autoCompactTokenLimit",
      control: "number",
      label: "Auto-compact token limit",
      clearWhenEmpty: "omit",
      minimum: 1,
      integerOnly: true,
    } as const;

    expect(
      nextProviderConfigWithFieldValue({ forkOwned: 1, autoCompactTokenLimit: 150_000 }, field, ""),
    ).toEqual({ forkOwned: 1 });
  });

  it.each([
    "NaN",
    "Infinity",
    "-Infinity",
    "1.5",
    "0",
    "-5",
    "abc",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects invalid numeric field input %s without persisting it", (rawValue) => {
    const field = {
      key: "autoCompactTokenLimit",
      control: "number",
      label: "Auto-compact token limit",
      clearWhenEmpty: "omit",
      minimum: 1,
      integerOnly: true,
    } as const;

    expect(
      nextProviderConfigWithFieldValue(
        { forkOwned: 1, autoCompactTokenLimit: 150_000 },
        field,
        rawValue,
      ),
    ).toEqual({ forkOwned: 1, autoCompactTokenLimit: 150_000 });
  });

  it("rejects numeric field input above its declared maximum", () => {
    const field = {
      key: "maxConcurrentSubagents",
      control: "number",
      label: "Maximum concurrent subagents",
      clearWhenEmpty: "omit",
      minimum: 1,
      maximum: 64,
      integerOnly: true,
    } as const;

    expect(nextProviderConfigWithFieldValue({ maxConcurrentSubagents: 12 }, field, "65")).toEqual({
      maxConcurrentSubagents: 12,
    });
  });

  it("allows finite fractional and negative values when a numeric field declares no constraints", () => {
    const field = {
      key: "offset",
      control: "number",
      label: "Offset",
      clearWhenEmpty: "omit",
    } as const;

    expect(nextProviderConfigWithFieldValue({}, field, "-1.5")).toEqual({ offset: -1.5 });
  });

  it("reads numeric config values with a fallback default", () => {
    expect(
      readProviderConfigNumber(
        { autoCompactTokenLimit: 150_000 },
        "autoCompactTokenLimit",
        200_000,
      ),
    ).toBe(150_000);
    expect(readProviderConfigNumber({}, "autoCompactTokenLimit", 200_000)).toBe(200_000);
    expect(
      readProviderConfigNumber(
        { autoCompactTokenLimit: "not-a-number" },
        "autoCompactTokenLimit",
        200_000,
      ),
    ).toBe(200_000);
  });
});
