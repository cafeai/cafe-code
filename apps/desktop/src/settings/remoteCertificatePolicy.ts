import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import * as tls from "node:tls";

export interface RemoteCertificatePin {
  readonly origin: string;
  readonly fingerprint256: string;
}

export function remoteCertificateOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || value.length > 2_048) return null;
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function eligibleRemoteCertificate(
  certificate: X509Certificate,
  origin: string,
  now = Date.now(),
): boolean {
  const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  return (
    Number.isFinite(certificate.validFromDate.getTime()) &&
    certificate.validFromDate.getTime() <= now &&
    certificate.validToDate.getTime() > now &&
    certificate.subject === certificate.issuer &&
    certificate.verify(certificate.publicKey) &&
    Boolean(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname))
  );
}

export function acceptsPinnedRemoteCertificate(
  pins: ReadonlyMap<string, string>,
  url: string,
  error: string,
  certificatePem: string,
  now = Date.now(),
): boolean {
  // Only an unrecognized authority is overridable. Name, expiry and other
  // Chromium failures retain their normal rejection behavior.
  if (error !== "net::ERR_CERT_AUTHORITY_INVALID") return false;
  const origin = remoteCertificateOrigin(url);
  if (!origin || !pins.has(origin)) return false;
  try {
    const certificate = new X509Certificate(certificatePem);
    return (
      pins.get(origin) === certificate.fingerprint256 &&
      eligibleRemoteCertificate(certificate, origin, now)
    );
  } catch {
    return false;
  }
}

export function decodeRemoteCertificatePins(raw: string): Map<string, string> {
  const pins = new Map<string, string>();
  if (Buffer.byteLength(raw) > 65_536) return pins;
  try {
    const document = JSON.parse(raw) as { version?: unknown; records?: unknown };
    if (document.version !== 1 || !Array.isArray(document.records) || document.records.length > 128)
      return pins;
    for (const record of document.records) {
      if (
        typeof record === "object" &&
        record !== null &&
        typeof record.origin === "string" &&
        remoteCertificateOrigin(record.origin) === record.origin &&
        typeof record.fingerprint256 === "string" &&
        /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(record.fingerprint256)
      )
        pins.set(record.origin, record.fingerprint256);
    }
  } catch {
    // Corrupt storage never grants trust.
  }
  return pins;
}

export type RemoteCertificateProbe =
  | { readonly status: "unchanged" | "invalid-certificate" | "unreachable" }
  | { readonly status: "self-signed"; readonly certificate: X509Certificate };

export function probeRemoteCertificate(origin: string): Promise<RemoteCertificateProbe> {
  const canonical = remoteCertificateOrigin(origin);
  if (!canonical) return Promise.resolve({ status: "invalid-certificate" });
  const url = new URL(canonical);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    // Inspection only: this socket sends no HTTP request, auth or application
    // data. Actual renderer traffic still requires normal TLS or an exact pin.
    const socket = tls.connect({
      host: hostname,
      port: Number(url.port || 443),
      ...(isIP(hostname) ? {} : { servername: hostname }),
      rejectUnauthorized: false,
    });
    let settled = false;
    const finish = (result: RemoteCertificateProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "unreachable" }), 6_000);
    socket.once("error", () => finish({ status: "unreachable" }));
    socket.once("secureConnect", () => {
      if (socket.authorized) return finish({ status: "unchanged" });
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        // Node exposes a string at runtime; some bundled type releases model
        // authorizationError as Error instead. Admit only the exact TLS code.
        const authorizationError: unknown = socket.authorizationError;
        finish(
          authorizationError === "DEPTH_ZERO_SELF_SIGNED_CERT" &&
            eligibleRemoteCertificate(certificate, canonical)
            ? { status: "self-signed", certificate }
            : { status: "invalid-certificate" },
        );
      } catch {
        finish({ status: "invalid-certificate" });
      }
    });
  });
}
