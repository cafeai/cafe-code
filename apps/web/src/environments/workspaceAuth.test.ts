import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  bearer: "owner-bearer",
  record: { httpBaseUrl: "https://pc.example:3775" },
  primaryCreate: vi.fn(),
}));
vi.mock("./primary", () => ({
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: "local" }),
  createServerPairingCredential: fixture.primaryCreate,
}));
vi.mock("./runtime/catalog", () => ({
  getSavedEnvironmentRecord: () => fixture.record,
  readSavedEnvironmentBearerToken: async () => fixture.bearer,
}));
import { createWorkspaceAuthApi } from "./workspaceAuth";
afterEach(() => vi.unstubAllGlobals());
it("binds remote administration to its bearer and final server address without forwarding cookies or secrets through redirects", async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ revokedCount: 2 }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  const auth = createWorkspaceAuthApi(EnvironmentId.make("remote"));
  await auth.setServerAdminPassword("new-password");
  expect(fetch).toHaveBeenLastCalledWith(
    "https://pc.example:3775/api/auth/admin-password",
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer owner-bearer" }),
      body: JSON.stringify({ password: "new-password" }),
    }),
  );
  expect(await auth.revokeOtherServerClientSessions()).toBe(2);
  expect(fixture.primaryCreate).not.toHaveBeenCalled();
});
it("does not publish remote error bodies or automatically replay auth mutations", async () => {
  const fetch = vi.fn(async () => new Response("private-password-detail", { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  await expect(
    createWorkspaceAuthApi(EnvironmentId.make("remote")).createServerPairingCredential(),
  ).rejects.toThrow("Remote auth request failed (403).");
  expect(fetch).toHaveBeenCalledOnce();
});
