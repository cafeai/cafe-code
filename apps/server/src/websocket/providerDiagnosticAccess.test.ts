import { describe, expect, it } from "vitest";
import {
  canReadProviderActivityDiagnostic,
  hasObservedPrivateRpcTransport,
} from "./providerDiagnosticAccess.ts";

describe("private provider activity diagnostic admission", () => {
  it("requires both an exact owner role and already-admitted secret transport", () => {
    for (const role of [
      "owner",
      "client",
      "guest",
      "OWNER",
      " owner",
      "owner ",
      "",
      null,
      undefined,
      false,
      {},
      ["owner"],
    ]) {
      for (const secure of [true, false]) {
        expect(canReadProviderActivityDiagnostic(role, secure)).toBe(role === "owner" && secure);
      }
    }
  });

  it("does not coerce an unknown identity into owner authority", () => {
    let coercions = 0;
    const role = {
      toString() {
        coercions += 1;
        return "owner";
      },
      valueOf() {
        coercions += 1;
        return "owner";
      },
    };
    expect(canReadProviderActivityDiagnostic(role, true)).toBe(false);
    expect(coercions).toBe(0);
  });

  it("retains the existing observed-peer loopback policy without granting remote cleartext access", () => {
    // These are exact scalar policy fixtures, not claims of a native remote
    // socket or TLS test. The shipped upgrade route supplies only the kernel's
    // observed remote address, never forwarded headers, to this existing check.
    for (const address of ["127.0.0.1", "127.42.1.9", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(
        canReadProviderActivityDiagnostic("owner", hasObservedPrivateRpcTransport(address)),
      ).toBe(true);
      expect(
        canReadProviderActivityDiagnostic("client", hasObservedPrivateRpcTransport(address)),
      ).toBe(false);
    }
    for (const address of [
      "192.168.86.35",
      "10.0.0.24",
      "::ffff:192.168.86.35",
      "example.local",
      "",
      "   ",
      "[]",
      "[ ]",
      "127.attacker.example",
      "127.0.0.999",
      "::ffff:127.attacker.example",
      undefined,
    ]) {
      expect(
        canReadProviderActivityDiagnostic("owner", hasObservedPrivateRpcTransport(address)),
      ).toBe(false);
    }
    // Missing observed-peer evidence is explicitly supplied as false by the
    // route. A valid owner identity never fills that missing transport proof.
    expect(canReadProviderActivityDiagnostic("owner", false)).toBe(false);
  });
});
