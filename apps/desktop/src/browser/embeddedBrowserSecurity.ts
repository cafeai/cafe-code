const BLANK_URL = "about:blank";

function isAllowedRemoteUrl(rawUrl: string): boolean {
  if (rawUrl === BLANK_URL) return true;
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** Normalize address input before navigation. This does not authorize an origin or request. */
export function normalizeEmbeddedBrowserUrl(rawUrl: string): string | null {
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawUrl.trim())
    ? rawUrl.trim()
    : `https://${rawUrl.trim()}`;
  if (!isAllowedRemoteUrl(candidate) || candidate === BLANK_URL) {
    return candidate === BLANK_URL ? BLANK_URL : null;
  }
  return new URL(candidate).href;
}

/** For display only: paths remain visible and may contain sensitive site-specific data. */
export function embeddedBrowserDisplayUrl(rawUrl: string): string {
  if (rawUrl === BLANK_URL || rawUrl.length === 0) return BLANK_URL;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return BLANK_URL;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return BLANK_URL;
  }
}

/** Heuristic redaction is not a guarantee that arbitrary page text contains no secrets. */
export function redactEmbeddedBrowserText(rawText: string, maxLength: number): string {
  // Invalid limits fail closed. Redact before clipping so a truncated token is not exposed.
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) return "";
  return rawText
    .replace(
      /\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})?\b/gi,
      "[redacted token]",
    )
    .replace(
      /\b(?:AKIA[A-Z0-9]{16}|(?:sk|api|key|token)[-_][A-Za-z0-9_-]{12,})\b/gi,
      "[redacted token]",
    )
    .replace(
      /\b(password|passwd|pwd|client[- ]secret|recovery[- ]code)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted secret]",
    )
    .replace(/\b\d{4,8}\b/g, "[redacted numeric code]")
    .replace(
      /((?:verification|security|one[- ]time|otp|2fa|passcode)[^\r\n]{0,32})\b[A-Z0-9-]{4,16}\b/gi,
      "$1[redacted code]",
    )
    .slice(0, maxLength);
}

function isIpv4LoopbackHostname(hostname: string): boolean {
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
}

/** Transport eligibility only. The caller must still require explicit user authorization. */
export function canTypeSensitiveValue(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:") return true;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      url.protocol === "http:" &&
      (hostname === "localhost" || hostname === "::1" || isIpv4LoopbackHostname(hostname))
    );
  } catch {
    return false;
  }
}
