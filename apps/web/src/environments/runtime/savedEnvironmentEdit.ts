import { uiText } from "@cafecode/shared/i18n";
import type { SavedEnvironmentRecord } from "./catalog";

export interface SavedEnvironmentEdit {
  readonly label: string;
  readonly host: string;
  readonly port: string;
}

export function savedEnvironmentEditFields(record: SavedEnvironmentRecord): SavedEnvironmentEdit {
  const url = new URL(record.httpBaseUrl);
  return {
    label: record.label,
    host: url.hostname,
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
  };
}

export function applySavedEnvironmentEdit(
  record: SavedEnvironmentRecord,
  input: SavedEnvironmentEdit,
): SavedEnvironmentRecord {
  const label = input.label.trim();
  if (!label) throw new Error(uiText("Enter a name for this environment."));
  const host = input.host.trim();
  const port = input.port.trim();
  if (!host || /[\s/@?#\\]/u.test(host)) {
    throw new Error(uiText("Enter a valid IP address or hostname."));
  }
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(uiText("Enter a port between 1 and 65535."));
  }
  const current = new URL(record.httpBaseUrl);
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw new Error(uiText("Remote servers must use HTTP or HTTPS."));
  }
  let url: URL;
  try {
    // Brackets let the separate host field accept ordinary IPv6 literals too.
    const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    url = new URL(`${current.protocol}//${hostname}:${Number(port)}/`);
  } catch {
    throw new Error(uiText("Enter a valid IP address or hostname."));
  }
  const httpBaseUrl = url.toString();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { ...record, label, httpBaseUrl, wsBaseUrl: url.toString() };
}
