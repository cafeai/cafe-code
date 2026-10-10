import { expect, it } from "vitest";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NATIVE_CONTROL_VERSION } from "@cafecode/shared/nativeControl";
import { NativeDaemon } from "./NativeDaemon.ts";

it.skipIf(process.env.CAFE_CODE_CUA_NATIVE_E2E !== "1")(
  "qualifies the prepared native daemon's owned readiness, session health and cleanup",
  async () => {
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
      "native/cua-driver/runtime",
      `${process.platform}-${process.arch}`,
    );
    const daemon = new NativeDaemon(root, "com.cafecode.NativeFixture");
    try {
      await daemon.start();
      const health = await daemon.health();
      // Cua returns tool failures as ordinary text content too. A received
      // reply alone cannot qualify Cafe's diagnostic tool mapping.
      expect(health.isError).not.toBe(true);
      expect(Array.isArray(health.content)).toBe(true);
      expect(health.content.some((item) => item.type === "text")).toBe(true);
      expect(health.structuredContent).toMatchObject({
        schema_version: "1",
        platform: "darwin",
        driver_version: NATIVE_CONTROL_VERSION,
        overall: expect.stringMatching(/^(ok|degraded|failed)$/u),
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "binary_version", status: "pass" }),
          expect.objectContaining({ name: "platform_supported", status: "pass" }),
          expect.objectContaining({
            name: "tcc_accessibility",
            status: expect.stringMatching(/^(pass|fail)$/u),
          }),
          expect.objectContaining({
            name: "tcc_screen_recording",
            status: expect.stringMatching(/^(pass|fail)$/u),
          }),
        ]),
      });
      // Ended labels are tombstoned by this daemon generation. Reacquisition
      // uses a distinct episode, as the host does for a still-connected chat.
      for (let episode = 0; episode < 2; episode++) {
        const connection = await daemon.session("native-fixture-screen-" + randomUUID());
        try {
          const screen = await connection.request({
            method: "trusted_session_call",
            name: "get_screen_size",
            args: {},
          });
          expect(Array.isArray(screen.content)).toBe(true);
          expect(screen.isError).not.toBe(true);
          const ended = await connection.request({ method: "trusted_session_end" });
          expect(ended.closed).toBe(true);
        } finally {
          connection.close();
        }
      }
    } finally {
      await daemon.stop();
    }
  },
  30_000,
);
