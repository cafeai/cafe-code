import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderAccountRateLimits,
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimitWindow,
  ServerProviderAccountRateLimitResetCredit,
} from "@cafecode/contracts";
import { ServerSettingsError } from "@cafecode/contracts";

import { createModelCapabilities } from "@cafecode/shared/model";
import {
  AUTH_PROBE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import packageJson from "../../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
} as const;

const MAX_PROVIDER_EMAIL_LENGTH = 320;
const CODEX_ACCOUNT_RATE_LIMIT_TIMEOUT_MS = 3_000;
const CODEX_CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ORIGINATOR = "cafecode_desktop";

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly accountRateLimits?: ServerProviderAccountRateLimits;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

function reasoningEffortLabel(reasoningEffort: string): string {
  // Codex rust-v0.143.0 keeps reasoning effort as a non-empty
  // open string advertised by the model. Keep known friendly labels, but never
  // reject or render an undefined label for a newly introduced upstream effort.
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

function normalizeProviderEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PROVIDER_EMAIL_LENGTH ||
    !trimmed.includes("@") ||
    hasUnsafeEmailCharacter(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function hasUnsafeEmailCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char.trim().length === 0 || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function readEmailField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return normalizeProviderEmail((value as Record<string, unknown>).email);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) return undefined;

  try {
    // This payload is only a local metadata source after `codex login status`
    // says Codex is authenticated. Cafe never treats this unsigned decode as an
    // auth proof, and `normalizeProviderEmail` bounds and sanitizes the only
    // field that crosses into the redacted settings UI.
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractCodexAuthEmail(authJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const record = parsed as Record<string, unknown>;
  const directEmail = readEmailField(record) ?? readEmailField(record.account);
  if (directEmail) return directEmail;

  const tokens = record.tokens;
  if (!tokens || typeof tokens !== "object") return undefined;
  const idToken = (tokens as Record<string, unknown>).id_token;
  if (typeof idToken !== "string" || idToken.length === 0) return undefined;
  return readEmailField(decodeJwtPayload(idToken));
}

function resolveCodexAuthFilePath(input: {
  readonly path: Path.Path;
  readonly codexSettings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}): string | undefined {
  const configuredHome = input.codexSettings.homePath.trim();
  const homePath =
    configuredHome.length > 0
      ? expandHomePath(configuredHome)
      : input.environment.CODEX_HOME?.trim()
        ? expandHomePath(input.environment.CODEX_HOME)
        : input.environment.HOME?.trim()
          ? input.path.join(input.environment.HOME, ".codex")
          : undefined;
  return homePath ? input.path.join(input.path.resolve(homePath), "auth.json") : undefined;
}

const readCodexAuthEmail = Effect.fn("readCodexAuthEmail")(function* (
  codexSettings: CodexSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = resolveCodexAuthFilePath({ path, codexSettings, environment });
  if (!authPath) return undefined;

  const isSymlink = yield* fileSystem.readLink(authPath).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (isSymlink) {
    return undefined;
  }

  const authJson = yield* fileSystem.readFileString(authPath).pipe(Effect.option);
  return Option.isSome(authJson) ? extractCodexAuthEmail(authJson.value) : undefined;
});

interface CodexUsageCredentials {
  readonly accessToken: string;
  readonly accountId?: string;
  readonly isFedrampAccount: boolean;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSafeHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 16_384) return undefined;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return undefined;
    }
  }
  return trimmed;
}

function readTrimmedMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const numeric = readFiniteNumber(value);
  return numeric !== undefined && Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const numeric = readFiniteNumber(value);
  return numeric !== undefined && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function windowMinutesFromSeconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  return Math.ceil(seconds / 60);
}

function readChatGptAuthClaims(idToken: unknown): Record<string, unknown> | undefined {
  if (typeof idToken !== "string" || idToken.length === 0) return undefined;
  return readRecord(decodeJwtPayload(idToken)?.["https://api.openai.com/auth"]);
}

function extractCodexUsageCredentials(authJson: string): CodexUsageCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch {
    return undefined;
  }

  const record = readRecord(parsed);
  if (!record || record.auth_mode !== "chatgpt") return undefined;

  const tokens = readRecord(record.tokens);
  const accessToken = readSafeHeaderValue(tokens?.access_token);
  if (!tokens || !accessToken) return undefined;

  const authClaims = readChatGptAuthClaims(tokens.id_token);
  const accountId =
    readSafeHeaderValue(tokens.account_id) ?? readSafeHeaderValue(authClaims?.chatgpt_account_id);
  const isFedrampAccount = authClaims?.chatgpt_account_is_fedramp === true;
  return {
    accessToken,
    ...(accountId ? { accountId } : {}),
    isFedrampAccount,
  };
}

const readCodexUsageCredentials = Effect.fn("readCodexUsageCredentials")(function* (
  codexSettings: CodexSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<CodexUsageCredentials | undefined, never, FileSystem.FileSystem | Path.Path> {
  // Provider snapshots normally receive the effective shadow CODEX_HOME from
  // `CodexDriver`; avoid reading a user's default ~/.codex during isolated
  // status tests or low-level helper calls that have not opted into a home.
  if (codexSettings.homePath.trim().length === 0 && !environment.CODEX_HOME?.trim()) {
    return undefined;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = resolveCodexAuthFilePath({ path, codexSettings, environment });
  if (!authPath) return undefined;

  const isSymlink = yield* fileSystem.readLink(authPath).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (isSymlink) {
    return undefined;
  }

  const authJson = yield* fileSystem.readFileString(authPath).pipe(Effect.option);
  return Option.isSome(authJson) ? extractCodexUsageCredentials(authJson.value) : undefined;
});

function mapGeneratedRateLimitWindow(
  window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
): ServerProviderAccountRateLimitWindow | null {
  if (!window) return null;
  return {
    usedPercent: window.usedPercent,
    ...(window.windowDurationMins !== undefined
      ? { windowDurationMins: window.windowDurationMins }
      : {}),
    ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
  };
}

function mapGeneratedCredits(
  credits: CodexSchema.V2GetAccountRateLimitsResponse__CreditsSnapshot | null,
): Exclude<ServerProviderAccountRateLimitSnapshot["credits"], undefined> {
  if (credits === null) return null;
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    ...(credits.balance !== undefined ? { balance: credits.balance } : {}),
  };
}

function mapGeneratedRateLimitSnapshot(
  snapshot: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitSnapshot,
): ServerProviderAccountRateLimitSnapshot {
  return {
    ...(snapshot.limitId !== undefined ? { limitId: snapshot.limitId } : {}),
    ...(snapshot.limitName !== undefined ? { limitName: snapshot.limitName } : {}),
    ...(snapshot.planType !== undefined ? { planType: snapshot.planType } : {}),
    ...(snapshot.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: snapshot.rateLimitReachedType }
      : {}),
    ...(snapshot.primary !== undefined
      ? { primary: mapGeneratedRateLimitWindow(snapshot.primary) }
      : {}),
    ...(snapshot.secondary !== undefined
      ? { secondary: mapGeneratedRateLimitWindow(snapshot.secondary) }
      : {}),
    ...(snapshot.credits !== undefined ? { credits: mapGeneratedCredits(snapshot.credits) } : {}),
  };
}

function mapGeneratedRateLimitResetCredits(
  summary:
    | CodexSchema.V2GetAccountRateLimitsResponse__RateLimitResetCreditsSummary
    | null
    | undefined,
): ServerProviderAccountRateLimits["rateLimitResetCredits"] | undefined {
  if (summary === undefined) return undefined;
  if (summary === null) return null;
  return {
    availableCount: summary.availableCount,
    ...(summary.credits !== undefined
      ? {
          credits:
            summary.credits === null ? null : summary.credits.map(mapGeneratedRateLimitResetCredit),
        }
      : {}),
  };
}

function mapGeneratedRateLimitResetCredit(
  credit: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitResetCredit,
): ServerProviderAccountRateLimitResetCredit {
  return {
    id: credit.id,
    resetType: credit.resetType,
    status: credit.status,
    grantedAt: credit.grantedAt,
    ...(credit.expiresAt !== undefined ? { expiresAt: credit.expiresAt } : {}),
    ...(credit.title !== undefined ? { title: credit.title } : {}),
    ...(credit.description !== undefined ? { description: credit.description } : {}),
  };
}

function codexAppServerRateLimitsToServer(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  checkedAt: string,
): ServerProviderAccountRateLimits {
  const byLimitId =
    response.rateLimitsByLimitId === null || response.rateLimitsByLimitId === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(response.rateLimitsByLimitId).map(([limitId, snapshot]) => [
            limitId,
            mapGeneratedRateLimitSnapshot(snapshot),
          ]),
        );
  const rateLimitResetCredits = mapGeneratedRateLimitResetCredits(response.rateLimitResetCredits);

  return {
    rateLimits: mapGeneratedRateLimitSnapshot(response.rateLimits),
    ...(byLimitId ? { rateLimitsByLimitId: byLimitId } : {}),
    ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
    checkedAt,
  };
}

function mapRawRateLimitWindow(value: unknown): ServerProviderAccountRateLimitWindow | null {
  const record = readRecord(value);
  if (!record) return null;

  const usedPercent = readFiniteNumber(record.used_percent ?? record.usedPercent);
  if (usedPercent === undefined) return null;

  const resetAt = readPositiveInteger(record.reset_at ?? record.resetsAt);
  const windowSeconds = readPositiveInteger(
    record.limit_window_seconds ?? record.limitWindowSeconds,
  );
  const windowDurationMins =
    readPositiveInteger(record.window_duration_mins ?? record.windowDurationMins) ??
    windowMinutesFromSeconds(windowSeconds);

  return {
    usedPercent,
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetAt !== undefined ? { resetsAt: resetAt } : {}),
  };
}

function mapRawCredits(value: unknown): ServerProviderAccountRateLimitSnapshot["credits"] {
  const record = readRecord(value);
  if (!record) return undefined;
  const hasCredits = record.has_credits ?? record.hasCredits;
  const unlimited = record.unlimited;
  if (typeof hasCredits !== "boolean" || typeof unlimited !== "boolean") {
    return undefined;
  }
  const balance = readTrimmedMetadata(record.balance);
  return {
    hasCredits,
    unlimited,
    ...(balance ? { balance } : {}),
  };
}

function mapRawRateLimitReachedType(value: unknown): string | undefined {
  const direct = readTrimmedMetadata(value);
  if (direct) return direct;
  const record = readRecord(value);
  return readTrimmedMetadata(record?.kind ?? record?.type);
}

function mapRawRateLimitResetCredits(
  value: unknown,
): ServerProviderAccountRateLimits["rateLimitResetCredits"] | undefined {
  if (value === null) return null;
  const record = readRecord(value);
  if (!record) return undefined;
  const availableCount = readNonNegativeInteger(record.available_count ?? record.availableCount);
  if (availableCount === undefined) return undefined;
  const rawCredits = record.credits;
  return {
    availableCount,
    ...(rawCredits === null
      ? { credits: null }
      : Array.isArray(rawCredits)
        ? {
            credits: rawCredits.map(mapRawRateLimitResetCredit).filter(isRateLimitResetCredit),
          }
        : {}),
  };
}

function isRateLimitResetCredit(
  value: ServerProviderAccountRateLimitResetCredit | null,
): value is ServerProviderAccountRateLimitResetCredit {
  return value !== null;
}

function mapRawRateLimitResetCredit(
  value: unknown,
): ServerProviderAccountRateLimitResetCredit | null {
  const record = readRecord(value);
  if (!record) return null;
  const id = readTrimmedMetadata(record.id);
  const grantedAt = readNonNegativeInteger(record.granted_at ?? record.grantedAt);
  if (!id || grantedAt === undefined) return null;
  const resetType = readTrimmedMetadata(record.reset_type ?? record.resetType);
  const status = readTrimmedMetadata(record.status);
  const expiresAt = readNonNegativeInteger(record.expires_at ?? record.expiresAt);
  const title = readTrimmedMetadata(record.title);
  const description = readTrimmedMetadata(record.description);
  return {
    id,
    resetType:
      resetType === "codexRateLimits" || resetType === "codex_rate_limits"
        ? "codexRateLimits"
        : "unknown",
    status:
      status === "available" ||
      status === "redeeming" ||
      status === "redeemed" ||
      status === "unknown"
        ? status
        : "unknown",
    grantedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

function mapRawRateLimitSnapshot(input: {
  readonly limitId: string;
  readonly limitName?: string | undefined;
  readonly rateLimit: unknown;
  readonly credits?: unknown;
  readonly planType?: string | undefined;
  readonly rateLimitReachedType?: string | undefined;
}): ServerProviderAccountRateLimitSnapshot {
  const rateLimit = readRecord(input.rateLimit);
  const primary = mapRawRateLimitWindow(rateLimit?.primary_window ?? rateLimit?.primary);
  const secondary = mapRawRateLimitWindow(rateLimit?.secondary_window ?? rateLimit?.secondary);
  const credits = mapRawCredits(input.credits);

  return {
    limitId: input.limitId,
    ...(input.limitName ? { limitName: input.limitName } : {}),
    ...(input.planType ? { planType: input.planType } : {}),
    ...(input.rateLimitReachedType ? { rateLimitReachedType: input.rateLimitReachedType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
  };
}

function parseCodexAccountRateLimitsPayload(
  payload: unknown,
  checkedAt: string,
): ServerProviderAccountRateLimits | undefined {
  const record = readRecord(payload);
  if (!record) return undefined;

  const planType = readTrimmedMetadata(record.plan_type ?? record.planType);
  const rateLimitReachedType = mapRawRateLimitReachedType(
    record.rate_limit_reached_type ?? record.rateLimitReachedType,
  );
  const rateLimitResetCredits = mapRawRateLimitResetCredits(
    record.rate_limit_reset_credits ?? record.rateLimitResetCredits,
  );
  const primarySnapshot = mapRawRateLimitSnapshot({
    limitId: "codex",
    rateLimit: record.rate_limit ?? record.rateLimit,
    credits: record.credits,
    ...(planType ? { planType } : {}),
    ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
  });
  const rateLimitsByLimitId: Record<string, ServerProviderAccountRateLimitSnapshot> = {
    codex: primarySnapshot,
  };

  const additionalRateLimits = record.additional_rate_limits ?? record.additionalRateLimits;
  if (Array.isArray(additionalRateLimits)) {
    for (const entry of additionalRateLimits) {
      const additional = readRecord(entry);
      const limitId = readTrimmedMetadata(
        additional?.metered_feature ?? additional?.meteredFeature,
      );
      if (!additional || !limitId) {
        continue;
      }
      rateLimitsByLimitId[limitId] = mapRawRateLimitSnapshot({
        limitId,
        limitName: readTrimmedMetadata(additional.limit_name ?? additional.limitName),
        rateLimit: additional.rate_limit ?? additional.rateLimit,
        ...(planType ? { planType } : {}),
      });
    }
  }

  return {
    rateLimits: rateLimitsByLimitId.codex ?? primarySnapshot,
    rateLimitsByLimitId,
    ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
    checkedAt,
  };
}

async function fetchCodexAccountRateLimits(input: {
  readonly credentials: CodexUsageCredentials;
  readonly checkedAt: string;
}): Promise<ServerProviderAccountRateLimits | undefined> {
  try {
    // Upstream Codex 0.143.0 fetches ChatGPT-backed account usage from
    // `{chatgpt_base_url}/wham/usage` via BackendClient::get_rate_limits_many
    // and sends Authorization plus ChatGPT-Account-ID when available. Cafe's
    // provider badge path intentionally avoids spawning a hidden app-server, so
    // this lightweight probe mirrors that HTTP request shape without logging or
    // returning any credential-bearing fields.
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.credentials.accessToken}`,
      originator: CODEX_ORIGINATOR,
      "user-agent": `${CODEX_ORIGINATOR}/${packageJson.version}`,
    };
    if (input.credentials.accountId) {
      headers["ChatGPT-Account-ID"] = input.credentials.accountId;
    }
    if (input.credentials.isFedrampAccount) {
      headers["X-OpenAI-Fedramp"] = "true";
    }

    const response = await fetch(CODEX_CHATGPT_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(CODEX_ACCOUNT_RATE_LIMIT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    return parseCodexAccountRateLimitsPayload(await response.json(), input.checkedAt);
  } catch {
    return undefined;
  }
}

const readCodexAccountRateLimits = Effect.fn("readCodexAccountRateLimits")(function* (
  codexSettings: CodexSettings,
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
): Effect.fn.Return<
  ServerProviderAccountRateLimits | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const credentials = yield* readCodexUsageCredentials(codexSettings, environment);
  if (!credentials) {
    return undefined;
  }
  return yield* Effect.promise(() => fetchCodexAccountRateLimits({ credentials, checkedAt }));
});

function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort === model.defaultReasoningEffort
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const supportsFastMode = (model.additionalSpeedTiers ?? []).includes("fast");
  return createModelCapabilities({
    optionDescriptors: [
      ...(reasoningOptions.length > 0
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              options: reasoningOptions,
              ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
            },
          ]
        : []),
      ...(supportsFastMode
        ? [
            {
              id: "fastMode",
              label: "Fast Mode",
              type: "boolean" as const,
            },
          ]
        : []),
    ],
  });
}

const toDisplayName = (model: CodexSchema.V2ModelListResponse__Model): string => {
  // Capitalize 'gpt' to 'GPT-' and capitalize any letter following a dash
  return model.displayName
    .replace(/^gpt/i, "GPT") // Handle start with 'gpt' or 'GPT'
    .replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
};

function makeStaticCodexReasoningCapabilities(input: {
  readonly defaultEffort: CodexSchema.V2ModelListResponse__ReasoningEffort;
  readonly supportedEfforts?: ReadonlyArray<CodexSchema.V2ModelListResponse__ReasoningEffort>;
  readonly supportsFastMode?: boolean;
}): ModelCapabilities {
  const supportedEfforts = input.supportedEfforts ?? ["low", "medium", "high", "xhigh"];
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select" as const,
        options: supportedEfforts.map((reasoningEffort) =>
          reasoningEffort === input.defaultEffort
            ? {
                id: reasoningEffort,
                label: reasoningEffortLabel(reasoningEffort),
                isDefault: true,
              }
            : {
                id: reasoningEffort,
                label: reasoningEffortLabel(reasoningEffort),
              },
        ),
        currentValue: input.defaultEffort,
      },
      ...(input.supportsFastMode
        ? [
            {
              id: "fastMode",
              label: "Fast Mode",
              type: "boolean" as const,
            },
          ]
        : []),
    ],
  });
}

const CODEX_STANDARD_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const CODEX_MAX_REASONING_EFFORTS = [...CODEX_STANDARD_REASONING_EFFORTS, "max"] as const;
// Mirrors Codex app-server `model/list` from codex-cli 0.144.0. The live
// app-server response remains authoritative when available; this fallback keeps
// fresh installs usable before the full Codex probe refreshes provider cache.
const CODEX_ULTRA_REASONING_EFFORTS = [...CODEX_MAX_REASONING_EFFORTS, "ultra"] as const;

// Lightweight provider status deliberately avoids `codex app-server`; keep a
// conservative model fallback so a fresh install still has selectable Codex
// models before the full app-server diagnostic path has ever populated cache.
const STATIC_CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "low",
      supportedEfforts: CODEX_ULTRA_REASONING_EFFORTS,
      supportsFastMode: true,
    }),
  },
  {
    slug: "gpt-5.6-terra",
    name: "GPT-5.6-Terra",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "medium",
      supportedEfforts: CODEX_ULTRA_REASONING_EFFORTS,
      supportsFastMode: true,
    }),
  },
  {
    slug: "gpt-5.6-luna",
    name: "GPT-5.6-Luna",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "medium",
      supportedEfforts: CODEX_MAX_REASONING_EFFORTS,
      supportsFastMode: true,
    }),
  },
  {
    slug: "gpt-5.5",
    name: "GPT-5.5",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "medium",
      supportedEfforts: CODEX_STANDARD_REASONING_EFFORTS,
      supportsFastMode: true,
    }),
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "medium",
      supportedEfforts: CODEX_STANDARD_REASONING_EFFORTS,
      supportsFastMode: true,
    }),
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "medium",
      supportedEfforts: CODEX_STANDARD_REASONING_EFFORTS,
    }),
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3-Codex-Spark",
    isCustom: false,
    capabilities: makeStaticCodexReasoningCapabilities({
      defaultEffort: "high",
      supportedEfforts: CODEX_STANDARD_REASONING_EFFORTS,
    }),
  },
];

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: toDisplayName(model),
    isCustom: false,
    capabilities: mapCodexModelCapabilities(model),
  }));
}

function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    customEntries.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities: fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClientShape,
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "cafecode_desktop",
      title: "Cafe Code Desktop",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly customModels?: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  // `~` is not shell-expanded when env vars are set via `child_process.spawn`,
  // so `CODEX_HOME=~/.codex_work` would reach codex verbatim and trip
  // "CODEX_HOME points to '~/.codex_work', but that path does not exist".
  // Expand here for parity with `CodexTextGeneration`/`CodexSessionRuntime`.
  const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
  const clientContext = yield* Layer.build(
    CodexClient.layerCommand({
      command: input.binaryPath,
      args: ["app-server"],
      cwd: input.cwd,
      env: {
        ...(input.environment ?? process.env),
        ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
      },
    }),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  const initialize = yield* client.request("initialize", {
    clientInfo: {
      name: "cafecode_desktop",
      title: "Cafe Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  yield* client.notify("initialized", undefined);

  // Extract the version string after the first '/' in userAgent, up to the next space or the end
  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: appendCustomCodexModels([], input.customModels ?? []),
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  const rateLimitsCheckedAt = DateTime.formatIso(yield* DateTime.now);
  const accountRateLimits = accountResponse.account
    ? yield* client.request("account/rateLimits/read", undefined).pipe(
        Effect.map((response) => codexAppServerRateLimitsToServer(response, rateLimitsCheckedAt)),
        Effect.option,
      )
    : Option.none<ServerProviderAccountRateLimits>();

  const [skillsResponse, models] = yield* Effect.all(
    [
      client.request("skills/list", {
        cwds: [input.cwd],
      }),
      requestAllCodexModels(client),
    ],
    { concurrency: "unbounded" },
  );

  return {
    account: accountResponse,
    ...(Option.isSome(accountRateLimits) ? { accountRateLimits: accountRateLimits.value } : {}),
    version,
    models: appendCustomCodexModels(models, input.customModels ?? []),
    skills: parseCodexSkillsListResponse(skillsResponse, input.cwd),
  } satisfies CodexAppServerProviderSnapshot;
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  codexSettings.customModels
    .map((model) => model.trim())
    .filter((model, index, models) => model.length > 0 && models.indexOf(model) === index)
    .map((model) => ({
      slug: model,
      name: model,
      isCustom: true,
      capabilities: null,
    }));

const fallbackCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  appendCustomCodexModels(STATIC_CODEX_MODELS, codexSettings.customModels);

const runCodexCommand = Effect.fn("runCodexCommand")(function* (
  codexSettings: CodexSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const resolvedHomePath = codexSettings.homePath ? expandHomePath(codexSettings.homePath) : "";
  const command = ChildProcess.make(codexSettings.binaryPath, [...args], {
    env: {
      ...environment,
      ...(resolvedHomePath.length > 0 ? { CODEX_HOME: resolvedHomePath } : {}),
    },
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(codexSettings.binaryPath, command);
});

function codexAuthProbeStatusFromLoginStatusResult(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly authEmail?: string | undefined;
}): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const normalized = output.toLowerCase();

  // Keep this parser aligned with upstream Codex CLI `codex login status`.
  // As of codex-cli 0.133.0, `codex-rs/cli/src/login.rs` prints one of:
  // "Logged in using ChatGPT", "Logged in using an API key - ...",
  // "Logged in using access token", or "Not logged in".
  if (result.code === 0) {
    if (normalized.includes("chatgpt")) {
      return {
        status: "ready",
        auth: {
          status: "authenticated",
          type: "chatgpt",
          label: "ChatGPT Subscription",
          ...(result.authEmail ? { email: result.authEmail } : {}),
        },
      };
    }

    if (normalized.includes("api key")) {
      return {
        status: "ready",
        auth: {
          status: "authenticated",
          type: "apiKey",
          label: "OpenAI API Key",
        },
      };
    }

    if (normalized.includes("access token")) {
      return {
        status: "ready",
        auth: {
          status: "authenticated",
          type: "accessToken",
          label: "Codex Access Token",
        },
      };
    }

    return {
      status: "warning",
      auth: { status: "unknown" },
      message: output
        ? `Codex CLI login status returned an unrecognized success response: ${output}`
        : "Codex CLI login status returned an unrecognized success response.",
    };
  }

  if (normalized.includes("not logged in")) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "error",
    auth: { status: "unknown" },
    message: detail
      ? `Codex CLI login status check failed. ${detail}`
      : "Codex CLI login status check failed.",
  };
}

const makePendingCodexProvider = (
  codexSettings: CodexSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = fallbackCodexModelsFromSettings(codexSettings);

    if (!codexSettings.enabled) {
      return buildServerProvider({
        presentation: CODEX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        skills: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in Cafe Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex provider status has not been checked in this session yet.",
      },
    });
  });

function accountProbeStatus(account: CodexAppServerProviderSnapshot["account"]): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const authEmail = codexAccountEmail(account.account);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly customModels: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = probeCodexAppServerProvider,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in Cafe Code settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    cwd: process.cwd(),
    customModels: codexSettings.customModels,
    environment,
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    const missingMessage =
      codexSettings.runtimeSource === "bundled"
        ? "Cafe Code bundled Codex runtime is not installed or not configured."
        : "Codex CLI (`codex`) is not installed or not on PATH.";
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : missingMessage,
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = accountProbeStatus(snapshot.account);

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: snapshot.models,
    skills: snapshot.skills,
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: accountStatus.status,
      auth: accountStatus.auth,
      ...(snapshot.accountRateLimits ? { accountRateLimits: snapshot.accountRateLimits } : {}),
      ...(accountStatus.message ? { message: accountStatus.message } : {}),
    },
  });
});

export const checkCodexCliProviderStatus = Effect.fn("checkCodexCliProviderStatus")(function* (
  codexSettings: CodexSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = fallbackCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in Cafe Code settings.",
      },
    });
  }

  const versionProbe = yield* runCodexCommand(codexSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    const detail = detailFromResult(versionResult);
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      },
    });
  }

  const loginStatusProbe = yield* runCodexCommand(
    codexSettings,
    ["login", "status"],
    environment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(loginStatusProbe)) {
    const error = loginStatusProbe.failure;
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: `Failed to execute Codex CLI login status check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(loginStatusProbe.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex CLI login status check timed out. Provider sessions may still work.",
      },
    });
  }

  const authEmail = yield* readCodexAuthEmail(codexSettings, environment);
  const accountStatus = codexAuthProbeStatusFromLoginStatusResult({
    ...loginStatusProbe.success.value,
    ...(authEmail ? { authEmail } : {}),
  });
  const accountRateLimits =
    accountStatus.auth.status === "authenticated" && accountStatus.auth.type === "chatgpt"
      ? yield* readCodexAccountRateLimits(codexSettings, environment, checkedAt)
      : undefined;
  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models,
    skills: [],
    probe: {
      installed: true,
      version: parsedVersion,
      status: accountStatus.status,
      auth: accountStatus.auth,
      ...(accountRateLimits ? { accountRateLimits } : {}),
      ...(accountStatus.message ? { message: accountStatus.message } : {}),
    },
  });
});

// NOTE: the singleton `CodexProviderLive` Layer has been removed as part of
// the per-instance-driver refactor. `CodexDriver.create()` builds a managed
// snapshot per instance (each with its own `CodexSettings`) and hands the
// resulting `ServerProviderShape` back as `ProviderInstance.snapshot`.
//
// `CodexDriver` uses `makePendingCodexProvider` plus the lightweight
// `checkCodexCliProviderStatus` path for normal startup snapshots. The full
// app-server status probe remains exported for targeted diagnostics and tests
// that need account/model metadata from Codex RPC itself.
export { makePendingCodexProvider };
