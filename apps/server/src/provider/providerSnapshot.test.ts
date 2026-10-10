import { describe, expect, it } from "vitest";
import { ProviderDriverKind, type ModelCapabilities } from "@cafecode/contracts";
import { createModelCapabilities } from "@cafecode/shared/model";

import { parseGenericCliVersion, providerModelsFromSettings } from "./providerSnapshot.ts";
import { supportsSubagentConcurrency } from "./Drivers/SubagentConcurrency.ts";

const CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("parseGenericCliVersion", () => {
  it("preserves stable version output used by every shared provider probe", () => {
    for (const [output, version] of [
      ["codex-cli 0.159.0\n", "0.159.0"],
      ["2.1.217 (Claude Code)\n", "2.1.217"],
      ["opencode 1.17.18\n", "1.17.18"],
      ["Grok CLI 0.9.3\n", "0.9.3"],
      ["version: 0.159.2\n", "0.159.2"],
      ["codex-cli-0.159.0\n", "0.159.0"],
    ] as const) {
      expect(parseGenericCliVersion(output)).toBe(version);
    }
  });

  it("does not turn a native prerelease token into qualified stable support", () => {
    for (const [driver, output, version] of [
      ["codex", "codex-cli 0.159.0-alpha.1\n", "0.159.0-alpha.1"],
      ["codex", "codex-cli 0.160.0-beta-2.1\n", "0.160.0-beta-2.1"],
      ["claudeAgent", "2.1.217-beta.1 (Claude Code)\n", "2.1.217-beta.1"],
      ["claudeAgent", "2.1.288-rc.1 (Claude Code)\n", "2.1.288-rc.1"],
    ] as const) {
      const parsed = parseGenericCliVersion(output);
      expect(parsed).toBe(version);
      expect(supportsSubagentConcurrency(driver, parsed)).toBe(false);
    }
    expect(supportsSubagentConcurrency("codex", parseGenericCliVersion("codex-cli 0.159.0"))).toBe(
      true,
    );
    expect(
      supportsSubagentConcurrency("claudeAgent", parseGenericCliVersion("2.1.217 (Claude Code)")),
    ).toBe(true);
  });

  it("refuses build metadata unsupported by shared minimum-version comparisons", () => {
    // A complete +build token must not reach shared comparison's lexical
    // fallback or be replaced by a later unrelated stable SDK version.
    for (const output of [
      "codex-cli 0.159.0+build.42\n",
      "2.1.29+build.1 (Claude Code)\n",
      "2.1.288-rc.1+build.4 (Claude Code)\n",
      "opencode 1.17.18-dev.3+local-build\n",
      "Grok CLI 0.9.3+build.1\n",
      "codex-cli 0.159.0+build.42\nunrelated SDK 9.9.9",
    ]) {
      const parsed = parseGenericCliVersion(output);
      expect(parsed).toBeNull();
      expect(supportsSubagentConcurrency("codex", parsed)).toBe(false);
      expect(supportsSubagentConcurrency("claudeAgent", parsed)).toBe(false);
    }
  });

  it("refuses unknown or malformed contiguous tokens instead of qualifying a numeric prefix", () => {
    for (const output of [
      "version unknown",
      "GPT-6.1-Sol",
      "codex-cli 0.159",
      "codex-cli 0.159\nunrelated SDK 9.9.9",
      "2.1 (Claude Code)\nunrelated SDK 9.9.9",
      "codex-cli 00.159.0",
      "codex-cli 0.0159.0",
      "codex-cli 0.159.00",
      "02.1.217 (Claude Code)",
      "codex-cli 0.159.0-",
      "codex-cli 0.159.0+",
      "codex-cli 0.159.0-alpha..1",
      "codex-cli 0.159.0+build..1",
      "codex-cli 0.159.0.1",
      "codex-cli 0.159.0bad",
      "codex-cli 0.159.0_beta",
      "codex-cli x0.159.0",
      "codex-cli 0.159.0-alpha..1\nunrelated SDK 9.9.9",
      "codex-cli 0.159.0-alpha..1-2.3.4",
    ]) {
      const parsed = parseGenericCliVersion(output);
      expect(parsed).toBeNull();
      expect(supportsSubagentConcurrency("codex", parsed)).toBe(false);
      expect(supportsSubagentConcurrency("claudeAgent", parsed)).toBe(false);
    }
  });
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ProviderDriverKind.make("codex"),
      ["openai/gpt-5"],
      CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });
});
