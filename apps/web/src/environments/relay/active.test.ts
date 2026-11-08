import { afterEach, expect, it, vi } from "vitest";
import { fetchAppResource } from "./active";

afterEach(() => vi.restoreAllMocks());

it("refuses an unbound relay target before any native fetch or DNS request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected-fetch"));
  await expect(
    fetchAppResource("https://unbound.cafecode-relay.invalid/api/auth/session"),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(fetch).not.toHaveBeenCalled();
});
