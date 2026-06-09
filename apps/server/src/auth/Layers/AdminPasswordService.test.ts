import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../Services/ServerSecretStore.ts";
import { AdminPasswordService } from "../Services/AdminPasswordService.ts";
import { AdminPasswordServiceLive } from "./AdminPasswordService.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";

const makeLayer = AdminPasswordServiceLive.pipe(
  Layer.provideMerge(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-admin-password-test-" })),
);

it.layer(NodeServices.layer)("AdminPasswordServiceLive", (it) => {
  it.effect("stores only a verifier and verifies matching passwords", () =>
    Effect.gen(function* () {
      const passwords = yield* AdminPasswordService;
      const secretStore = yield* ServerSecretStore;

      expect(yield* passwords.isConfigured).toBe(false);
      yield* passwords.setPassword("correct horse battery staple");
      expect(yield* passwords.isConfigured).toBe(true);
      expect(yield* passwords.verifyPassword("correct horse battery staple")).toBe(true);
      expect(yield* passwords.verifyPassword("wrong horse battery staple")).toBe(false);

      const stored = yield* secretStore.get("admin-password-verifier");
      expect(stored).not.toBeNull();
      expect(new TextDecoder().decode(stored ?? new Uint8Array())).not.toContain(
        "correct horse battery staple",
      );
    }).pipe(Effect.provide(makeLayer)),
  );

  it.effect("rejects empty and short passwords", () =>
    Effect.gen(function* () {
      const passwords = yield* AdminPasswordService;

      yield* Effect.flip(passwords.setPassword(""));
      yield* Effect.flip(passwords.setPassword("short"));
      expect(yield* passwords.isConfigured).toBe(false);
    }).pipe(Effect.provide(makeLayer)),
  );

  it.effect("fails closed for malformed verifier data", () =>
    Effect.gen(function* () {
      const passwords = yield* AdminPasswordService;
      const secretStore = yield* ServerSecretStore;

      yield* secretStore.set("admin-password-verifier", new TextEncoder().encode("not-a-verifier"));

      const error = yield* Effect.flip(passwords.verifyPassword("password123"));
      expect(error.message).toBe("Stored admin password verifier is malformed.");
    }).pipe(Effect.provide(makeLayer)),
  );

  it.effect("clears configured passwords", () =>
    Effect.gen(function* () {
      const passwords = yield* AdminPasswordService;

      yield* passwords.setPassword("correct horse battery staple");
      expect(yield* passwords.isConfigured).toBe(true);
      yield* passwords.clearPassword;
      expect(yield* passwords.isConfigured).toBe(false);
      expect(yield* passwords.verifyPassword("correct horse battery staple")).toBe(false);
    }).pipe(Effect.provide(makeLayer)),
  );
});
