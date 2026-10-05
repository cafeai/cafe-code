import { beforeEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Option from "effect/Option";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
const { viewerRequest } = vi.hoisted(() => ({
  viewerRequest: vi.fn((_input: unknown) => ({ lease: "fixture" })),
}));
vi.mock("../virtualDesktop/service.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeDesktopService: Effect.succeed({
      request: (input: unknown) =>
        Effect.try({ try: () => viewerRequest(input), catch: (error) => error }),
    }),
  };
});
import { handleWorkspaceRequest } from "./http.ts";
const id = "00000000-0000-4000-8000-000000000001";
async function request(
  role: "owner" | "client" | "anonymous",
  address: string | undefined,
  body: object,
) {
  const webRequest = HttpServerRequest.fromWeb(
    new Request("http://localhost/api/workspace", { method: "POST", body: JSON.stringify(body) }),
  );
  Object.defineProperty(webRequest, "remoteAddress", {
    value: address ? Option.some(address) : Option.none(),
  });
  return Effect.runPromise(
    handleWorkspaceRequest.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, webRequest),
      Effect.provideService(ServerConfig, {} as never),
      Effect.provideService(ServerSettingsService, { getSettings: Effect.succeed({}) } as never),
      Effect.provideService(ServerAuth, {
        authenticateHttpRequest: () =>
          role === "anonymous"
            ? Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }))
            : Effect.succeed({ role, sessionId: "fixture-owner" }),
      } as never),
    ),
  );
}
beforeEach(() => {
  viewerRequest.mockReset().mockReturnValue({ lease: "fixture" });
});
it("requires an authenticated owner and protected transport before admitting viewer control", async () => {
  const input = { operation: "desktop-viewer", id, command: "take-control" };
  expect((await request("anonymous", "127.0.0.1", input)).status).toBe(401);
  expect((await request("client", "127.0.0.1", input)).status).toBe(403);
  expect((await request("owner", "192.0.2.1", input)).status).toBe(403);
  expect((await request("owner", undefined, input)).status).toBe(403);
  expect(viewerRequest).not.toHaveBeenCalled();
  expect((await request("owner", "127.0.0.1", input)).status).toBe(200);
  expect(viewerRequest).toHaveBeenCalledWith({
    operation: "remote-viewer",
    id,
    command: "take-control",
    owner: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
it.each([
  { operation: "read-file", cwd: "/fixture", relativePath: "file.txt" },
  {
    operation: "save-file",
    cwd: "/fixture",
    relativePath: "file.txt",
    contents: "fixture",
    expectedRevision: "0".repeat(64),
  },
  { operation: "open-terminal", cwd: "/fixture", cols: 80, rows: 24 },
  { operation: "read-terminal", id },
  { operation: "write-terminal", id, data: "fixture" },
  { operation: "resize-terminal", id, cols: 80, rows: 24 },
  { operation: "close-terminal", id },
])("rejects the removed $operation operation even for an authenticated owner", async (input) => {
  expect((await request("owner", "127.0.0.1", input)).status).toBe(400);
  expect(viewerRequest).not.toHaveBeenCalled();
});
it("rejects malformed controls and keeps private failures out of responses", async () => {
  expect(
    (await request("owner", "127.0.0.1", { operation: "desktop-viewer", id, command: "invalid" }))
      .status,
  ).toBe(400);
  viewerRequest.mockImplementationOnce(() => {
    throw new Error("private-token-and-path");
  });
  const response = await request("owner", "127.0.0.1", {
    operation: "desktop-viewer",
    id,
    command: "take-control",
  });
  expect(response.status).toBe(409);
  expect(await HttpServerResponse.toWeb(response).text()).toBe("");
});
