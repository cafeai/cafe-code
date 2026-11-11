import { expect, it, vi } from "vitest";
import { EnvironmentId } from "@cafecode/contracts";
import { createIdentity } from "@cafecode/relay/crypto";
import { randomOpaque } from "@cafecode/relay/bytes";
import { encodeSavedRelaySecret, decodeSavedRelaySecret } from "./savedSecret";
import { activateSavedRelay } from "./saved";
import { fetchAppResource, readSavedRelay, savedRelayUrls, type SavedRelayTarget } from "./active";

async function fixture() {
  const identity = await createIdentity();
  const target: SavedRelayTarget = {
    id: randomOpaque(),
    networkId: randomOpaque(),
    rootPublicKey: randomOpaque(),
    bootstrapUrls: ["https://relay.example/v1/network"],
    minimumRevision: 2,
    hostPublicKey: randomOpaque(),
    environmentId: randomOpaque(),
    locator: randomOpaque(),
    preferredNodeId: randomOpaque(),
    bearerToken: "test-owned-bearer",
    tickets: [],
  };
  const record = {
    ...savedRelayUrls(target.id),
    transport: "relay" as const,
    environmentId: EnvironmentId.make(target.environmentId),
    label: "Remote Cafe",
    createdAt: "2026-11-10T00:00:00.000Z",
    lastConnectedAt: null,
  };
  return { identity, target, record, secret: encodeSavedRelaySecret(target, identity) };
}

it("restores the exact device identity and rejects cross-environment or oversized secrets", async () => {
  const f = await fixture();
  const decoded = decodeSavedRelaySecret(f.secret, f.target.environmentId);
  expect(decoded.identity.publicKey).toBe(f.identity.publicKey);
  expect(decoded.target).toEqual(f.target);
  expect(() => decodeSavedRelaySecret(f.secret, "other-environment")).toThrow();
  expect(() => decodeSavedRelaySecret("x".repeat(16_385), f.target.environmentId)).toThrow();
});

it("binds saved HTTP/socket metadata before installing any relay transport", async () => {
  const f = await fixture();
  expect(() =>
    activateSavedRelay({ ...f.record, httpBaseUrl: "https://wrong.example/" }, f.secret),
  ).toThrow();
  expect(readSavedRelay(f.record.httpBaseUrl)).toBeUndefined();
});

it("routes only the exact saved owner and removes its reserved origin on close", async (test) => {
  let owned: ReturnType<typeof activateSavedRelay> | undefined;
  const cleanup = async () => {
    await owned?.relay.close();
    vi.restoreAllMocks();
  };
  test.onTestFinished(cleanup);
  test.signal.addEventListener(
    "abort",
    () => {
      void owned?.relay.close();
    },
    { once: true },
  );
  const f = await fixture();
  const nativeFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected-native-fetch"));
  owned = activateSavedRelay(f.record, f.secret);
  const request = vi
    .spyOn(owned.relay, "request")
    .mockResolvedValue(new Response("encrypted-test-response"));
  expect(activateSavedRelay(f.record, f.secret).relay).toBe(owned.relay);
  const response = await fetchAppResource(new URL("/api/auth/session", f.record.httpBaseUrl));
  expect(await response.text()).toBe("encrypted-test-response");
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/auth/session", undefined);
  expect(nativeFetch).not.toHaveBeenCalled();
  const otherKey = await createIdentity();
  expect(() => activateSavedRelay(f.record, encodeSavedRelaySecret(f.target, otherKey))).toThrow();
  await owned.relay.close();
  await expect(fetchAppResource(f.record.httpBaseUrl)).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(nativeFetch).not.toHaveBeenCalled();
});
