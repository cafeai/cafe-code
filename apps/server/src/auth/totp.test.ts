import { describe, expect, it } from "vitest";
import { createTotpSecret, recoveryHash, totpAtStep } from "./totp.ts";

describe("TOTP interoperable SHA-1 vectors", () => {
  // RFC 6238 Appendix B uses the ASCII key 12345678901234567890 and eight
  // digits. Six digits retain its last six, per RFC 4226 dynamic truncation.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("matches the standard vector at %i seconds", (seconds, expected) => {
    expect(totpAtStep(secret, Math.floor(Number(seconds) / 30))).toBe(expected);
  });
  it("creates 160-bit app-compatible secrets and normalizes recovery separators", () => {
    expect(createTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(recoveryHash("ABCDEF12-34567890-ABCDEF12-34567890")).toBe(
      recoveryHash("abcdef1234567890abcdef1234567890"),
    );
  });
});
