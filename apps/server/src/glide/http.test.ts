import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { handleGlideMcpRequest } from "./http.ts";
import { installGlideSessionRuntime } from "./sessionRuntime.ts";

describe("Glide MCP HTTP admission", () => {
  it("requires observed loopback and exact session audience before parsing any tool body", async () => {
    const operation = vi.fn(async () => {
      throw new Error("Unknown token.");
    });
    const uninstall = installGlideSessionRuntime({ bind: async () => undefined, operation });
    const handle = (peer: string, token?: string, proxy = false) =>
      Effect.runPromise(
        handleGlideMcpRequest.pipe(
          Effect.provideService(ServerConfig, {} as never),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://127.0.0.1/mcp/glide", {
                method: "POST",
                body: "invalid JSON",
                headers: {
                  ...(token ? { authorization: `Bearer ${token}` } : {}),
                  ...(proxy ? { "x-cafe-code-https-proxy": "1" } : {}),
                  "x-forwarded-for": "127.0.0.1",
                },
              }),
            ).modify({ remoteAddress: Option.some(peer) }),
          ),
        ),
      );
    try {
      expect((await handle("192.0.2.1", "ab".repeat(32))).status).toBe(403);
      expect((await handle("127.0.0.1", "ab".repeat(32), true)).status).toBe(403);
      expect((await handle("127.0.0.1")).status).toBe(401);
      expect(operation).not.toHaveBeenCalled();
      expect((await handle("127.0.0.1", "ab".repeat(32))).status).toBe(403);
      expect(operation).toHaveBeenCalledExactlyOnceWith(
        { kind: "catalog", token: "ab".repeat(32) },
        undefined,
      );
    } finally {
      uninstall();
    }
  });
});
