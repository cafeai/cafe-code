import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import * as tls from "node:tls";
import { describe, expect, it } from "vitest";

import {
  acceptsPinnedRemoteCertificate,
  decodeRemoteCertificatePins,
  eligibleRemoteCertificate,
  probeRemoteCertificate,
  remoteCertificateOrigin,
} from "./remoteCertificatePolicy.ts";

// Disposable localhost fixture identity. This key must never be used by an app
// listener or real server; it authenticates no user and protects no real data.
const cert = readFileSync(
  new URL("./__fixtures__/remote-tls/test-only-cert.pem", import.meta.url),
  "utf8",
);
const key = readFileSync(
  new URL("./__fixtures__/remote-tls/test-only-key.pem", import.meta.url),
  "utf8",
);
const certificate = new X509Certificate(cert);
const origin = "https://127.0.0.1:3775";
const pins = new Map([[origin, certificate.fingerprint256]]);
const duringValidity = certificate.validFromDate.getTime() + 60_000;

describe("remote certificate policy", () => {
  it("pins HTTPS and WSS to the exact origin, port and certificate", () => {
    expect(
      acceptsPinnedRemoteCertificate(
        pins,
        `${origin}/api/auth/session`,
        "net::ERR_CERT_AUTHORITY_INVALID",
        cert,
        duringValidity,
      ),
    ).toBe(true);
    expect(
      acceptsPinnedRemoteCertificate(
        pins,
        "wss://127.0.0.1:3775/?wsToken=opaque",
        "net::ERR_CERT_AUTHORITY_INVALID",
        cert,
        duringValidity,
      ),
    ).toBe(true);
    for (const url of [
      "https://127.0.0.1:3776/",
      "https://localhost:3775/",
      "http://127.0.0.1:3775/",
      "https://user:secret@127.0.0.1:3775/",
      "invalid",
    ]) {
      expect(
        acceptsPinnedRemoteCertificate(
          pins,
          url,
          "net::ERR_CERT_AUTHORITY_INVALID",
          cert,
          duringValidity,
        ),
      ).toBe(false);
    }
    expect(
      acceptsPinnedRemoteCertificate(
        new Map([[origin, "changed"]]),
        origin,
        "net::ERR_CERT_AUTHORITY_INVALID",
        cert,
        duringValidity,
      ),
    ).toBe(false);
    expect(remoteCertificateOrigin("wss://[::1]:3775/")).toBe("https://[::1]:3775");
  });

  it("does not override name, validity, revocation or malformed certificate failures", () => {
    for (const error of [
      "net::ERR_CERT_DATE_INVALID",
      "net::ERR_CERT_COMMON_NAME_INVALID",
      "net::ERR_CERT_REVOKED",
      "net::ERR_FAILED",
    ]) {
      expect(acceptsPinnedRemoteCertificate(pins, origin, error, cert, duringValidity)).toBe(false);
    }
    expect(eligibleRemoteCertificate(certificate, "https://wrong.example", duringValidity)).toBe(
      false,
    );
    expect(
      eligibleRemoteCertificate(certificate, origin, certificate.validFromDate.getTime() - 1),
    ).toBe(false);
    expect(
      acceptsPinnedRemoteCertificate(
        pins,
        origin,
        "net::ERR_CERT_AUTHORITY_INVALID",
        cert,
        certificate.validToDate.getTime() + 1,
      ),
    ).toBe(false);
    expect(
      acceptsPinnedRemoteCertificate(
        pins,
        origin,
        "net::ERR_CERT_AUTHORITY_INVALID",
        "malformed",
        duringValidity,
      ),
    ).toBe(false);
  });

  it("restores only bounded canonical pins and fails closed on corrupt storage", () => {
    const record = { origin, fingerprint256: certificate.fingerprint256 };
    expect(decodeRemoteCertificatePins(JSON.stringify({ version: 1, records: [record] }))).toEqual(
      pins,
    );
    for (const raw of [
      "invalid",
      "null",
      JSON.stringify({ version: 2, records: [record] }),
      " ".repeat(65_537),
      JSON.stringify({ version: 1, records: Array(129).fill(record) }),
    ]) {
      expect(decodeRemoteCertificatePins(raw).size).toBe(0);
    }
    expect(
      decodeRemoteCertificatePins(
        JSON.stringify({
          version: 1,
          records: [
            record,
            { origin: `${origin}/path`, fingerprint256: record.fingerprint256 },
            { origin: "http://bad", fingerprint256: record.fingerprint256 },
          ],
        }),
      ),
    ).toEqual(pins);
  });

  it("inspects a real TLS handshake without sending HTTP or application data", async () => {
    let applicationBytes = 0;
    const sockets = new Set<tls.TLSSocket>();
    const server = tls.createServer({ cert, key }, (socket) => {
      sockets.add(socket);
      socket.on("data", (data: Buffer) => {
        applicationBytes += data.length;
      });
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const result = await probeRemoteCertificate(`https://127.0.0.1:${address.port}`);
      expect(result.status).toBe("self-signed");
      if (result.status === "self-signed")
        expect(result.certificate.fingerprint256).toBe(certificate.fingerprint256);
      expect(applicationBytes).toBe(0);
      expect(await probeRemoteCertificate("http://127.0.0.1")).toEqual({
        status: "invalid-certificate",
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
