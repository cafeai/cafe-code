import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBackendBootstrap } from "@cafecode/contracts";
import { connectLocalVirtualDesktop } from "./virtualDesktop.ts";

const input = {
  id: "68a669ad-0443-45b9-b2c6-8b04920b337f",
  environmentUrl: "http://127.0.0.1:1234/",
};
const config = {
  httpBaseUrl: new URL(input.environmentUrl),
  bootstrap: { desktopBootstrapToken: "private-local-bootstrap" } as DesktopBackendBootstrap,
};
afterEach(() => vi.unstubAllGlobals());
describe("local virtual desktop connect", () => {
  it("rejects remote environments, non-Linux clients, and missing desktop authority before any request", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      connectLocalVirtualDesktop(
        { ...input, environmentUrl: "https://remote.example/" },
        config,
        "linux",
      ),
    ).rejects.toThrow();
    await expect(connectLocalVirtualDesktop(input, config, "darwin")).rejects.toThrow();
    await expect(connectLocalVirtualDesktop(input, null, "linux")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("sends the matching bootstrap only to the fixed backend path and forwards display variables only", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", request);
    await connectLocalVirtualDesktop(input, config, "linux", {
      DISPLAY: ":fixture",
      WAYLAND_DISPLAY: "wayland-fixture",
      UNRELATED_SECRET: "do-not-forward",
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:1234/api/virtual-desktops/connect");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer private-local-bootstrap" },
    });
    expect(JSON.parse(init.body)).toEqual({
      id: input.id,
      environment: { DISPLAY: ":fixture", WAYLAND_DISPLAY: "wayland-fixture" },
    });
  });
});
