import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { canLoginProvider } from "./providerLoginAccess.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

describe("provider login authorization", () => {
  it("admits the legacy default Codex account and honors its effective enabled policy", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: true },
      },
      providerInstances: {},
    };
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    expect(instance?.driver).toBe("codex");
    expect(canLoginProvider({ role: "owner", secureSecretTransport: true, instance })).toBe(true);
    const disabled = deriveProviderInstanceConfigMap({
      ...settings,
      providers: { ...settings.providers, codex: { ...settings.providers.codex, enabled: false } },
    })[instanceId];
    expect(
      canLoginProvider({ role: "owner", secureSecretTransport: true, instance: disabled }),
    ).toBe(false);
    expect(
      canLoginProvider({
        role: "owner",
        secureSecretTransport: true,
        instance: { ...disabled!, enabled: true },
      }),
    ).toBe(true);
  });
  for (const driver of ["codex", "claudeAgent", "axiom"]) {
    it(`requires an owner, secure transport and enabled ${driver} instance`, () => {
      const instance = { driver: ProviderDriverKind.make(driver) };
      expect(canLoginProvider({ role: "owner", secureSecretTransport: true, instance })).toBe(true);
      for (const role of ["client", "viewer", "member", "", "admin"])
        expect(canLoginProvider({ role, secureSecretTransport: true, instance })).toBe(false);
      expect(canLoginProvider({ role: "owner", secureSecretTransport: false, instance })).toBe(
        false,
      );
      expect(
        canLoginProvider({
          role: "owner",
          secureSecretTransport: true,
          instance: { ...instance, enabled: false },
        }),
      ).toBe(false);
      expect(
        canLoginProvider({ role: "owner", secureSecretTransport: true, instance: undefined }),
      ).toBe(false);
    });
  }
});
