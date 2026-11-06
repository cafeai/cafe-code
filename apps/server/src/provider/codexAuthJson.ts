/**
 * Local, unsigned inspection of Codex `auth.json` contents.
 *
 * Nothing here is an authentication proof. These helpers only compare two
 * credential files Cafe already owns on disk so the shadow-home materializer can
 * decide which copy is the more recent renewal of the same login. Callers must
 * never log, publish or persist the values read here.
 */

/** auth.json is a few KiB; anything larger is not a file Cafe should reason about. */
const MAX_AUTH_JSON_BYTES = 64 * 1024;

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (!payload) return undefined;

  try {
    // Unsigned decode: callers use the result only as local metadata (an email
    // for the redacted settings UI, or a subject for same-login comparison).
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ChatgptLogin {
  readonly authMode: string;
  readonly accountId: string;
  readonly subject: string;
  readonly refreshToken: string;
  readonly lastRefreshMs: number;
}

function readChatgptLogin(json: string): ChatgptLogin | undefined {
  if (json.length > MAX_AUTH_JSON_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const root = record(parsed);
  const tokens = record(root?.tokens);
  const authMode = nonEmptyString(root?.auth_mode);
  const accountId = nonEmptyString(tokens?.account_id);
  const refreshToken = nonEmptyString(tokens?.refresh_token);
  const idToken = nonEmptyString(tokens?.id_token);
  const lastRefresh = nonEmptyString(root?.last_refresh);
  if (!authMode || !accountId || !refreshToken || !idToken || !lastRefresh) return undefined;
  if (!nonEmptyString(tokens?.access_token)) return undefined;
  const subject = nonEmptyString(decodeJwtPayload(idToken)?.sub);
  const lastRefreshMs = Date.parse(lastRefresh);
  if (!subject || !Number.isFinite(lastRefreshMs)) return undefined;
  return { authMode, accountId, subject, refreshToken, lastRefreshMs };
}

/**
 * True only when `candidate` is a strictly newer token renewal of exactly the
 * same ChatGPT login as `current`: same auth mode, workspace account and user
 * subject, a different (rotated) refresh token and a later `last_refresh`.
 *
 * OpenAI refresh tokens are single-use. When Codex renews a login inside an
 * auth-overlay shadow home, the renewed tokens exist only in that shadow copy
 * while the shared copy still holds the consumed refresh token. Treating the
 * shared copy as authoritative would then reinstate a dead token ("refresh
 * token was already used"). Requiring the same subject means a different user
 * signing in through the shared home (even in the same workspace) is never
 * overwritten by an older process's renewal; anything unparseable, API-key
 * based or ambiguous returns false so the existing shared-wins policy applies.
 */
export function isNewerRenewalOfSameCodexLogin(candidate: string, current: string): boolean {
  const next = readChatgptLogin(candidate);
  const previous = readChatgptLogin(current);
  if (!next || !previous) return false;
  return (
    next.authMode === previous.authMode &&
    next.accountId === previous.accountId &&
    next.subject === previous.subject &&
    next.refreshToken !== previous.refreshToken &&
    next.lastRefreshMs > previous.lastRefreshMs
  );
}
