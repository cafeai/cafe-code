import { EnvironmentId } from "@cafecode/contracts";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  selected: "local",
  connected: true,
  bearer: vi.fn(),
}));
vi.mock("./environments/workspace", () => ({
  readWorkspaceEnvironmentId: () => fixture.selected,
  useWorkspaceEnvironmentId: () => fixture.selected,
}));
vi.mock("./environments/primary", () => ({
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: "local" }),
  usePrimaryEnvironmentId: () => "local",
  getPrimaryKnownEnvironment: () => ({ environmentId: "local" }),
}));
vi.mock("./environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `http://localhost${path}`,
}));
vi.mock("./environments/runtime/catalog", () => ({
  readSavedEnvironmentBearerToken: fixture.bearer,
  resolveEnvironmentHttpUrl: ({
    environmentId,
    pathname,
  }: {
    environmentId: string;
    pathname: string;
  }) => `https://${environmentId}.invalid${pathname}`,
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      byId: { remote: { connectionState: fixture.connected ? "connected" : "disconnected" } },
    }),
  },
}));
import { uploadSidebarBrandImage } from "./brandingImages";
const asset = {
  id: `sha256-${"a".repeat(64)}.png`,
  url: `/api/branding/sidebar-image/sha256-${"a".repeat(64)}.png`,
  mimeType: "image/png",
  width: 1,
  height: 1,
  sizeBytes: 1,
};
const fetchMock = vi.fn();
beforeEach(() => {
  fixture.selected = "local";
  fixture.connected = true;
  fixture.bearer.mockReset().mockResolvedValue("synthetic-test-session");
  fetchMock.mockReset().mockImplementation(async () => Response.json({ sidebarBrandImage: asset }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it("preserves primary uploads and sends remote branding only to its captured server with bearer authentication", async () => {
  const file = new File(["test"], "test.png", { type: "image/png" });
  await uploadSidebarBrandImage(file);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "http://localhost/api/branding/sidebar-image",
    expect.objectContaining({ credentials: "include", body: file }),
  );
  expect(fixture.bearer).not.toHaveBeenCalled();
  let resolve!: (token: string) => void;
  fixture.bearer.mockImplementation(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  fixture.selected = "remote";
  const upload = uploadSidebarBrandImage(file);
  fixture.selected = "local";
  resolve("synthetic-test-session");
  await expect(upload).resolves.toEqual(asset);
  expect(fixture.bearer).toHaveBeenCalledWith("remote");
  expect(fetchMock).toHaveBeenLastCalledWith(
    "https://remote.invalid/api/branding/sidebar-image",
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      body: file,
    }),
  );
  const headers = fetchMock.mock.calls.at(-1)![1].headers as Headers;
  expect(headers.get("authorization")).toBe("Bearer synthetic-test-session");
  expect(headers.get("content-type")).toBe("image/png");
});
it("never falls back to a primary upload when remote branding is unavailable and redacts server error bodies", async () => {
  const file = new File(["test"], "test.png", { type: "image/png" });
  fixture.connected = false;
  await expect(uploadSidebarBrandImage(file, EnvironmentId.make("remote"))).rejects.toThrow(
    "Reconnect",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  fixture.connected = true;
  fetchMock.mockResolvedValue(new Response("private-server-details", { status: 403 }));
  await expect(uploadSidebarBrandImage(file, EnvironmentId.make("remote"))).rejects.toThrow(
    "Could not load or save the selected server",
  );
  expect(fetchMock.mock.calls.every(([url]) => url.startsWith("https://remote.invalid/"))).toBe(
    true,
  );
  fetchMock.mockResolvedValue(new Response("private-invalid-response", { status: 200 }));
  await expect(uploadSidebarBrandImage(file, EnvironmentId.make("remote"))).rejects.toThrow(
    "Sidebar image upload returned an invalid response.",
  );
});
