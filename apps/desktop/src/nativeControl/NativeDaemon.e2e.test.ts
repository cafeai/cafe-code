import { expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
      expect(Array.isArray(health.content)).toBe(true);
      expect(health.content.some((item) => item.type === "text")).toBe(true);
      const connection = await daemon.session("native-fixture-screen");
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
    } finally {
      await daemon.stop();
    }
  },
  30_000,
);
