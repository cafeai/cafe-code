import {
  CodexSettings,
  ClaudeSettings,
  GrokSettings,
  OpenCodeSettings,
} from "@cafecode/contracts/settings";
import { uiText } from "@cafecode/shared/i18n";
import type { ProviderClientDefinition } from "./providerDriverMeta";
import type { ProviderSettingsFieldModel } from "./ProviderSettingsForm";

type DisplayMetadata = Pick<ProviderSettingsFieldModel, "label"> &
  Partial<Pick<ProviderSettingsFieldModel, "description" | "detail" | "placeholder" | "options">>;

// This is presentation for Cafe's reviewed built-in schemas, not a translator
// for received provider metadata or custom schemas. The canonical annotations
// and every setting/option value stay unchanged for decoding and persistence.
const CodexSettingsCopy: Readonly<Record<string, DisplayMetadata>> = {
  binaryPath: {
    get label() {
      return uiText("Binary path");
    },
  },
  runtimeSource: {
    get label() {
      return uiText("Runtime");
    },
    options: [
      {
        value: "system",
        get label() {
          return uiText("System CLI");
        },
        get description() {
          return uiText("Use the provider CLI from PATH or the configured binary path.");
        },
      },
      {
        value: "bundled",
        get label() {
          return uiText("Bundled runtime");
        },
        get description() {
          return uiText("Use Cafe Code's managed Windows runtime and provider install.");
        },
      },
    ],
  },
  homePath: {
    get label() {
      return uiText("Codex home folder");
    },
    get detail() {
      return uiText("Sets CODEX_HOME, the folder for Codex config, sign-in and history.");
    },
  },
  shadowHomePath: {
    get label() {
      return uiText("Shadow home folder");
    },
    get description() {
      return uiText("Separate sign-in that shares this home's history and config.");
    },
    get detail() {
      return uiText(
        "Sign-in is kept in a private file; config, history and the history database stay shared. Use a different Codex home folder for separate history.",
      );
    },
  },
  maxConcurrentSubagents: {
    get label() {
      return uiText("Maximum concurrent subagents");
    },
    get description() {
      return uiText(
        "Spawned agents open at once (1–64; main agent excluded). Blank: Codex default.",
      );
    },
    get detail() {
      return uiText(
        "Blank uses the model, backend and config defaults: without an override, V2 models allow 3 spawned agents and V1 models allow 6.",
      );
    },
    get placeholder() {
      return uiText("Provider default");
    },
  },
  autoCompactTokenLimit: {
    get label() {
      return uiText("Auto-compact override");
    },
    get description() {
      return uiText("Token count that triggers compaction. Blank: Codex's per-model default.");
    },
  },
};

const ClaudeSettingsCopy: Readonly<Record<string, DisplayMetadata>> = {
  binaryPath: {
    get label() {
      return uiText("Binary path");
    },
  },
  runtimeSource: {
    get label() {
      return uiText("Runtime");
    },
    options: [
      {
        value: "system",
        get label() {
          return uiText("System CLI");
        },
        get description() {
          return uiText("Use the provider CLI from PATH or the configured binary path.");
        },
      },
      {
        value: "bundled",
        get label() {
          return uiText("Bundled runtime");
        },
        get description() {
          return uiText("Use Cafe Code's managed Windows runtime and provider install.");
        },
      },
    ],
  },
  homePath: {
    get label() {
      return uiText("Claude home folder");
    },
    get description() {
      return uiText("Keeps this account's Claude sign-in and settings separate.");
    },
    get detail() {
      return uiText("Sets HOME when running Claude, so its .claude.json and .claude live here.");
    },
  },
  maxConcurrentSubagents: {
    get label() {
      return uiText("Agent-tool concurrency limit");
    },
    get description() {
      return uiText(
        "Max Agent-tool subagents, 1–64. Blank: inherited or 20. Change between sessions.",
      );
    },
    get detail() {
      return uiText(
        "Sets CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (Claude Code 2.1.217+). Saving reloads this account. Limits Agent-tool spawning, not all running work: resumes and manual forks can exceed it, ultracode is exempt, and workflows/teams use separate limits.",
      );
    },
    get placeholder() {
      return uiText("Inherited / provider default");
    },
  },
  maxOutputTokens: {
    get label() {
      return uiText("Maximum response tokens");
    },
    get description() {
      return uiText("Cafe supports 1–128,000 response tokens. Blank: inherited or model default.");
    },
    get detail() {
      return uiText(
        "Sets CLAUDE_CODE_MAX_OUTPUT_TOKENS for new chat queries, subject to the model's ceiling. Larger budgets can increase output cost and reduce context room before compaction. Saving reloads this account: change between sessions. Metadata helpers and login/health checks keep their existing output policy.",
      );
    },
    get placeholder() {
      return uiText("Inherited / model default");
    },
  },
  launchArgs: {
    get label() {
      return uiText("Launch arguments");
    },
    get description() {
      return uiText("Additional CLI arguments passed on session start.");
    },
    get placeholder() {
      return uiText("e.g. {arguments}", { arguments: "--chrome" });
    },
  },
};

const GrokSettingsCopy: Readonly<Record<string, DisplayMetadata>> = {
  binaryPath: {
    get label() {
      return uiText("Binary path");
    },
  },
  homePath: {
    get label() {
      return uiText("Grok home folder");
    },
    get description() {
      return uiText("Blank reuses your existing grok login.");
    },
    get detail() {
      return uiText("Sets GROK_HOME for this account.");
    },
    get placeholder() {
      return uiText("Default Grok home");
    },
  },
};

const OpenCodeSettingsCopy: Readonly<Record<string, DisplayMetadata>> = {
  binaryPath: {
    get label() {
      return uiText("Binary path");
    },
  },
  serverUrl: {
    get label() {
      return uiText("Server URL");
    },
    get description() {
      return uiText("Blank: Cafe Code starts a local OpenCode server.");
    },
  },
  serverPassword: {
    get label() {
      return uiText("Server password");
    },
    get description() {
      return uiText("Only needed for an external server.");
    },
    get placeholder() {
      return uiText("Optional");
    },
  },
};

export function localizeProviderSettingsField(
  definition: ProviderClientDefinition,
  field: ProviderSettingsFieldModel,
): ProviderSettingsFieldModel {
  const copy =
    definition.settingsSchema === CodexSettings
      ? CodexSettingsCopy
      : definition.settingsSchema === ClaudeSettings
        ? ClaudeSettingsCopy
        : definition.settingsSchema === GrokSettings
          ? GrokSettingsCopy
          : definition.settingsSchema === OpenCodeSettings
            ? OpenCodeSettingsCopy
            : null;
  const display = copy && Object.hasOwn(copy, field.key) ? copy[field.key] : undefined;
  return display ? { ...field, ...display } : field;
}
