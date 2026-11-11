/**
 * Renderer-side Cafe Secrets admission.
 *
 * The composer syntax `[sec:VALUE]` must never reach optimistic messages,
 * persisted drafts/queues or provider dispatch as raw text. Every send path
 * therefore asks the exact captured environment/thread to `prepare` the text
 * (replacing complete unescaped markers with `[CAFE_SECRET_<id>]`) before any
 * local insertion. Escaped `\[sec:...]` text is deliberately retained verbatim
 * here and by the shared parser so that retries/second admission are no-ops.
 *
 * Capability is fail-closed: an unsupported driver, an older backend without
 * the optional `threadSecrets` API, or any capability read failure means the
 * send is blocked rather than forwarding the raw value.
 */
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import {
  containsCafeSecrets,
  findCafeSecretRanges,
  hasCafeSecretReference,
  supportsCafeSecrets,
} from "@cafecode/shared/cafeSecrets";

import { readEnvironmentApi } from "../environmentApi";

/** Optional API: old backends omit it entirely. */
export function readThreadSecretsApi(environmentId: EnvironmentId) {
  return readEnvironmentApi(environmentId)?.threadSecrets;
}

export type ThreadSecretsApiHandle = NonNullable<ReturnType<typeof readThreadSecretsApi>>;

/** Positive results stay cached for a minute; failures are retried sooner. */
const CAPABILITY_SUCCESS_TTL_MS = 60_000;
const CAPABILITY_FAILURE_TTL_MS = 5_000;
const MAX_CAPABILITY_ENTRIES = 64;

interface CapabilityEntry {
  /**
   * The exact connection-owned API object that answered. Replacing a saved
   * server's connection under the same EnvironmentId yields a new object, so
   * a cached answer from the retired transport is never reused.
   */
  readonly api: ThreadSecretsApiHandle;
  readonly promise: Promise<boolean>;
  expiresAt: number;
}

const capabilityCache = new Map<string, CapabilityEntry>();

const capabilityKey = (environmentId: EnvironmentId, instanceId: ProviderInstanceId) =>
  `${environmentId}\u0000${instanceId}`;

function loadCapabilityFromApi(
  api: ThreadSecretsApiHandle,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): Promise<boolean> {
  const key = capabilityKey(environmentId, instanceId);
  const now = Date.now();
  const cached = capabilityCache.get(key);
  if (cached && cached.api === api && cached.expiresAt > now) return cached.promise;
  const entry: CapabilityEntry = {
    api,
    expiresAt: now + CAPABILITY_SUCCESS_TTL_MS,
    promise: api
      .capabilities({ providerInstanceId: instanceId })
      .then((result) => {
        if (result.supported !== true) entry.expiresAt = Date.now() + CAPABILITY_FAILURE_TTL_MS;
        return result.supported === true;
      })
      .catch(() => {
        entry.expiresAt = Date.now() + CAPABILITY_FAILURE_TTL_MS;
        return false;
      }),
  };
  capabilityCache.delete(key);
  capabilityCache.set(key, entry);
  while (capabilityCache.size > MAX_CAPABILITY_ENTRIES) {
    const oldest = capabilityCache.keys().next().value;
    if (oldest === undefined) break;
    capabilityCache.delete(oldest);
  }
  return entry.promise;
}

/**
 * Resolve whether the exact environment's provider instance supports Cafe
 * Secrets through its current connection. Never throws: every failure is
 * `false` (fail closed).
 */
export function loadCafeSecretsCapability(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string | undefined;
}): Promise<boolean> {
  if (!supportsCafeSecrets(input.driver)) return Promise.resolve(false);
  const api = readThreadSecretsApi(input.environmentId);
  if (!api) return Promise.resolve(false);
  return loadCapabilityFromApi(api, input.environmentId, input.instanceId);
}

/** Test-only reset for the module cache. */
export function resetCafeSecretsCapabilityCacheForTests() {
  capabilityCache.clear();
}

export type CafeSecretSendIssue = "unsupported" | "incomplete" | "failed";

export type CafeSecretPreparation =
  | { readonly ok: true; readonly text: string; readonly prepared: boolean }
  | { readonly ok: false; readonly issue: CafeSecretSendIssue };

/**
 * Outgoing text needs secret admission when it carries raw unescaped markers
 * or any existing `[CAFE_SECRET_...]` reference (copied, stale or foreign).
 * References are validated by the server for this exact thread, so a removed
 * or foreign id is rejected before it can enter optimistic history.
 */
export const needsCafeSecretAdmission = (text: string): boolean =>
  containsCafeSecrets(text) || hasCafeSecretReference(text);

/** True when a range ends without its closing bracket (still being typed). */
export function hasIncompleteCafeSecret(text: string): boolean {
  return findCafeSecretRanges(text).some(
    (range) => text[range.end - 1] !== "]" || range.end - range.start <= 6,
  );
}

/**
 * Prepare outgoing composer text for one exact captured environment/thread.
 * Text without unescaped markers is returned unchanged without any RPC.
 */
export async function prepareCafeSecretsForSend(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string | undefined;
  readonly text: string;
}): Promise<CafeSecretPreparation> {
  if (!needsCafeSecretAdmission(input.text)) return { ok: true, text: input.text, prepared: false };
  if (!supportsCafeSecrets(input.driver)) return { ok: false, issue: "unsupported" };
  // Capture one connection-owned API for both the capability answer and the
  // preparation so a replaced transport cannot mix their authority.
  const api = readThreadSecretsApi(input.environmentId);
  if (!api) return { ok: false, issue: "unsupported" };
  const supported = await loadCapabilityFromApi(api, input.environmentId, input.instanceId);
  if (!supported) return { ok: false, issue: "unsupported" };
  if (hasIncompleteCafeSecret(input.text)) return { ok: false, issue: "incomplete" };
  try {
    const result = await api.prepare({
      threadId: input.threadId,
      providerInstanceId: input.instanceId,
      text: input.text,
    });
    // Defense in depth: a prepared result must never still carry a marker.
    if (containsCafeSecrets(result.text)) return { ok: false, issue: "failed" };
    return { ok: true, text: result.text, prepared: true };
  } catch {
    return { ok: false, issue: "failed" };
  }
}

export { redactCafeSecretsForPersistence } from "./draftRedaction";
