import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
const catalog = vi.hoisted(() => ({ record: vi.fn(), token: vi.fn() }));
vi.mock("./primary", () => ({
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: "primary" }),
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `https://primary.example${path}`,
}));
vi.mock("./runtime/catalog", () => ({
  getSavedEnvironmentRecord: catalog.record,
  readSavedEnvironmentBearerToken: catalog.token,
}));
import { createTwoFactorApi, TwoFactorApiError } from "./twoFactorApi";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.resetAllMocks();
});

describe("two-factor management server ownership", () => {
  it("uses the selected saved server's bearer for every management action", async () => {
    catalog.record.mockReturnValue({ httpBaseUrl: "https://selected.example/" });
    catalog.token.mockResolvedValue("selected-bearer");
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}"));
    globalThis.fetch = fetchMock;
    const api = createTwoFactorApi(EnvironmentId.make("selected"));
    await api.status();
    await api.begin();
    await api.enable("123456");
    await api.disable("unused-recovery");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://selected.example/api/auth/two-factor",
      "https://selected.example/api/auth/two-factor/setup",
      "https://selected.example/api/auth/two-factor/enable",
      "https://selected.example/api/auth/two-factor/disable",
    ]);
    for (const [, request] of fetchMock.mock.calls)
      expect(request).toMatchObject({
        credentials: "omit",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer selected-bearer" }),
      });
    expect(fetchMock.mock.calls[2]![1].body).toBe(JSON.stringify({ code: "123456" }));
    expect(fetchMock.mock.calls[3]![1].body).toBe(JSON.stringify({ code: "unused-recovery" }));
    expect(catalog.token.mock.calls).toEqual(Array.from({ length: 4 }, () => ["selected"]));
  });
  it("uses only the primary cookie when managing the primary server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    globalThis.fetch = fetchMock;
    await createTwoFactorApi(EnvironmentId.make("primary")).enable("123456");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://primary.example/api/auth/two-factor/enable",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        redirect: "error",
        body: JSON.stringify({ code: "123456" }),
      }),
    );
    expect(catalog.token).not.toHaveBeenCalled();
  });
  it("refuses a missing saved bearer without falling back to primary authority", async () => {
    catalog.record.mockReturnValue({ httpBaseUrl: "https://selected.example/" });
    catalog.token.mockResolvedValue(null);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(
      createTwoFactorApi(EnvironmentId.make("selected")).disable("unused-recovery"),
    ).rejects.toMatchObject({ kind: "request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not replay throttled requests or render received error text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("private secret-bearing response", { status: 429 }));
    globalThis.fetch = fetchMock;
    const error = await createTwoFactorApi(null)
      .enable("123456")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TwoFactorApiError);
    expect(error).toMatchObject({ kind: "limited" });
    expect(String(error)).not.toContain("private");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
