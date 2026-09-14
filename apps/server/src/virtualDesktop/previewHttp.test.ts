import { expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { handleDesktopPreviewRequest } from "./previewHttp.ts";
import { desktopError } from "./nativeClient.ts";
const preview = vi.hoisted(() => vi.fn());
vi.mock("./runtime.ts", () => ({ readDesktopManager: () => ({ preview }) }));
const id = "24ff9ac9-1d98-4bb9-9d3f-1e868663a064";
const image =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
const request = (role: "owner" | "guest" | "anonymous", desktop = id) =>
  Effect.runPromise(
    handleDesktopPreviewRequest.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://localhost/api/virtual-desktops/previews/${desktop}`),
        ),
      ),
      Effect.provideService(ServerAuth, {
        authenticateHttpRequest: () =>
          role === "anonymous"
            ? Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }))
            : Effect.succeed({ role }),
      } as never),
      Effect.provideService(ServerConfig, {} as never),
      Effect.provideService(ServerSettingsService, { getSettings: Effect.succeed({}) } as never),
    ),
  );
it("authenticates owners and validates desktop ids before capturing private pixels", async () => {
  preview.mockReset();
  expect((await request("anonymous")).status).toBe(401);
  expect((await request("guest")).status).toBe(403);
  expect((await request("owner", "invalid-id")).status).toBe(400);
  expect(preview).not.toHaveBeenCalled();
  preview.mockResolvedValue({ image });
  const response = await request("owner");
  expect(preview).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(
    Buffer.from(await HttpServerResponse.toWeb(response).arrayBuffer()).toString("base64"),
  ).toBe(image);
});
it("bounds images and returns sanitized policy, busy and missing results", async () => {
  preview.mockResolvedValueOnce({ image: "a".repeat(800_000) });
  expect((await request("owner")).status).toBe(503);
  preview.mockResolvedValueOnce({ image: "cHJpdmF0ZQ==" });
  expect((await request("owner")).status).toBe(503);
  preview.mockRejectedValueOnce(desktopError("busy", "private detail"));
  expect((await request("owner")).status).toBe(429);
  preview.mockRejectedValueOnce(desktopError("feature_disabled", "private detail"));
  const disabled = await request("owner");
  expect(disabled.status).toBe(403);
  expect(await HttpServerResponse.toWeb(disabled).text()).toBe("");
});
