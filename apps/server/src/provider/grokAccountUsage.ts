/**
 * Grok account-usage discovery.
 *
 * Grok Build's public ACP process did not route `x.ai/billing` in the 1.0.4
 * stable build even though the interactive client used the same handler.
 * Upstream's handler reads the current `GROK_HOME/auth.json` bearer and calls
 * the CLI proxy's `/billing?format=credits` endpoint. This module mirrors only
 * that bounded, read-only fallback and returns Cafe's existing rate-limit
 * shape. It deliberately drops balances, top-up configuration, product cost,
 * identity metadata, and the rest of the upstream billing response.
 *
 * Upstream reference:
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs
 */
import * as NodeOS from "node:os";

import type {
  GrokSettings,
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimits,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import packageJson from "../../package.json" with { type: "json" };

const GROK_CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_BILLING_TIMEOUT_MS = 5_000;
const MAX_AUTH_FILE_CHARACTERS = 1_048_576;
const MAX_HEADER_VALUE_CHARACTERS = 16_384;

interface GrokUsageCredentials {
  readonly accessToken: string;
  readonly userId: string;
}

export interface GrokAccountUsageReadOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly nowMs?: number;
  readonly clientVersion?: string | null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSafeHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADER_VALUE_CHARACTERS) return undefined;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return trimmed;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readAmount(value: unknown): number | undefined {
  return readFiniteNumber(readRecord(value)?.val);
}

function parseTimestampMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1_000;
    return milliseconds > 0 ? milliseconds : undefined;
  }
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function parseCredentialExpiryMillis(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  return parseTimestampMillis(value) ?? null;
}

function credentialScopeRank(scope: string): number {
  return scope.startsWith("https://auth.x.ai::")
    ? 0
    : scope === "https://accounts.x.ai/sign-in"
      ? 1
      : 2;
}

function extractGrokUsageCredentials(
  authJson: string,
  nowMs: number,
): GrokUsageCredentials | undefined {
  if (authJson.length > MAX_AUTH_FILE_CHARACTERS) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch {
    return undefined;
  }

  const store = readRecord(parsed);
  if (!store) return undefined;

  // The OIDC entry is the current `grok login` identity. Keep the legacy
  // grok.com session as a compatibility fallback, but never treat the xAI API
  // key entry as a subscription credential for this endpoint.
  const candidates = Object.entries(store)
    .filter(([scope]) => scope !== "xai::api_key")
    .toSorted(([left], [right]) => credentialScopeRank(left) - credentialScopeRank(right));

  for (const [, value] of candidates) {
    const credential = readRecord(value);
    if (!credential) continue;
    const accessToken = readSafeHeaderValue(credential.key);
    const userId = readSafeHeaderValue(credential.user_id);
    if (!accessToken || !userId) continue;

    const expiresAt = parseCredentialExpiryMillis(credential.expires_at);
    if (expiresAt === null || (expiresAt !== undefined && expiresAt <= nowMs)) continue;
    return { accessToken, userId };
  }
  return undefined;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function readUsagePercent(config: Record<string, unknown>): number | undefined {
  const direct = readFiniteNumber(config.creditUsagePercent);
  if (direct !== undefined) return clampPercentage(direct);

  // Older Grok billing responses used an included monthly limit instead of
  // the unified percentage. This ratio is still subscription usage. Do not
  // fall back to on-demand cap/balance fields: those are monetary controls and
  // are intentionally outside Cafe's standard quota surface.
  const monthlyLimit = readAmount(config.monthlyLimit);
  const totalUsed = readAmount(readRecord(config.usage)?.totalUsed);
  if (monthlyLimit === undefined || monthlyLimit <= 0 || totalUsed === undefined) {
    return undefined;
  }
  return clampPercentage((totalUsed / monthlyLimit) * 100);
}

/** Decode both the CLI-proxy response and the future ACP extension response. */
export function parseGrokAccountRateLimitsPayload(
  payload: unknown,
  checkedAt: string,
): ServerProviderAccountRateLimits | undefined {
  const outer = readRecord(payload);
  const response = readRecord(outer?.result) ?? outer;
  const config = readRecord(response?.config);
  if (!config) return undefined;

  const currentPeriod = readRecord(config.currentPeriod);
  const startsAtMs = parseTimestampMillis(currentPeriod?.start ?? config.billingPeriodStart);
  const resetsAtMs = parseTimestampMillis(currentPeriod?.end ?? config.billingPeriodEnd);
  const usedPercent = readUsagePercent(config);
  if (usedPercent === undefined && resetsAtMs === undefined) return undefined;

  const windowDurationMins =
    startsAtMs !== undefined && resetsAtMs !== undefined && resetsAtMs > startsAtMs
      ? Math.ceil((resetsAtMs - startsAtMs) / 60_000)
      : undefined;
  const primary = {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    ...(resetsAtMs !== undefined ? { resetsAt: Math.floor(resetsAtMs / 1_000) } : {}),
  };
  const snapshot = {
    limitId: "grok",
    limitName: "Grok usage",
    primary,
  } satisfies ServerProviderAccountRateLimitSnapshot;

  return {
    rateLimits: snapshot,
    rateLimitsByLimitId: { grok: snapshot },
    checkedAt,
  };
}

function resolveGrokAuthFilePath(input: {
  readonly path: Path.Path;
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
}): string {
  const configuredHome = input.settings.homePath.trim();
  const environmentHome = input.environment.GROK_HOME?.trim();
  const homePath = configuredHome
    ? expandHomePath(configuredHome)
    : environmentHome
      ? expandHomePath(environmentHome)
      : input.path.join(NodeOS.homedir(), ".grok");
  return input.path.join(input.path.resolve(homePath), "auth.json");
}

async function fetchGrokAccountRateLimits(input: {
  readonly credentials: GrokUsageCredentials;
  readonly checkedAt: string;
  readonly fetch: typeof globalThis.fetch;
  readonly clientVersion?: string | null;
}): Promise<ServerProviderAccountRateLimits | undefined> {
  try {
    const response = await input.fetch(GROK_CLI_BILLING_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.credentials.accessToken}`,
        "x-xai-token-auth": "xai-grok-cli",
        "x-userid": input.credentials.userId,
        "user-agent": `CafeCode/${packageJson.version}`,
        ...(input.clientVersion ? { "x-grok-client-version": input.clientVersion } : {}),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(GROK_BILLING_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseGrokAccountRateLimitsPayload(await response.json(), input.checkedAt);
  } catch {
    // Provider quota is optional display metadata. Authentication, network,
    // response, and decode failures must neither break Grok health nor expose
    // an upstream body that could contain account information.
    return undefined;
  }
}

/**
 * Read only Grok's redacted subscription usage snapshot.
 *
 * The bearer stays inside this module and is sent only as an HTTPS header to
 * Grok's fixed CLI-proxy origin. It is never returned, logged, persisted by
 * Cafe, placed in argv, or made visible to the renderer.
 */
export const readGrokAccountRateLimits = Effect.fn("readGrokAccountRateLimits")(function* (
  settings: GrokSettings,
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
  options: GrokAccountUsageReadOptions = {},
): Effect.fn.Return<
  ServerProviderAccountRateLimits | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = resolveGrokAuthFilePath({ path, settings, environment });

  // Never follow an auth-file symlink. Aside from keeping credential ownership
  // explicit, this prevents a hostile workspace/user config from redirecting
  // Cafe's background usage reader to an arbitrary file.
  const isSymlink = yield* fileSystem.readLink(authPath).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (isSymlink) return undefined;

  const authJson = yield* fileSystem.readFileString(authPath).pipe(Effect.option);
  if (Option.isNone(authJson)) return undefined;
  const credentials = extractGrokUsageCredentials(authJson.value, options.nowMs ?? Date.now());
  if (!credentials) return undefined;

  return yield* Effect.promise(() =>
    fetchGrokAccountRateLimits({
      credentials,
      checkedAt,
      fetch: options.fetch ?? globalThis.fetch,
      ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    }),
  );
});
