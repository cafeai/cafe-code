import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { DesktopBackendBootstrap } from "./desktopBootstrap.ts";

const isDesktopBackendBootstrap = Schema.is(DesktopBackendBootstrap);
const legacyEnvelope = {
  mode: "desktop",
  noBrowser: true,
  port: 13773,
  cafeCodeHome: "/synthetic/effective-root",
  host: "127.0.0.1",
  desktopBootstrapToken: "separate-browser-bootstrap-credential",
};

describe("desktop private readiness bootstrap", () => {
  it("retains legacy omission and admits only exact 32-byte lowercase hex keys", () => {
    expect(isDesktopBackendBootstrap(legacyEnvelope)).toBe(true);
    expect(
      isDesktopBackendBootstrap({ ...legacyEnvelope, desktopReadinessToken: "ab".repeat(32) }),
    ).toBe(true);
    for (const desktopReadinessToken of [
      "",
      "ab".repeat(31),
      "ab".repeat(33),
      "AB".repeat(32),
      "g".repeat(64),
      `${"ab".repeat(32)}\n`,
      42,
      null,
      {},
    ]) {
      expect(isDesktopBackendBootstrap({ ...legacyEnvelope, desktopReadinessToken })).toBe(false);
    }
  });
});
