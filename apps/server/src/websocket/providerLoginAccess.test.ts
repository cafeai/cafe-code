import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { canLoginProvider, canLoginProviderDeviceCode } from "./providerLoginAccess.ts";
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
    expect(
      canLoginProviderDeviceCode({ role: "client", secureSecretTransport: true, instance }),
    ).toBe(true);
    const disabled = deriveProviderInstanceConfigMap({
      ...settings,
      providers: { ...settings.providers, codex: { ...settings.providers.codex, enabled: false } },
    })[instanceId];
    expect(
      canLoginProvider({ role: "owner", secureSecretTransport: true, instance: disabled }),
    ).toBe(false);
    expect(
      canLoginProviderDeviceCode({
        role: "client",
        secureSecretTransport: true,
        instance: disabled,
      }),
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

  it("admits only authenticated Owner and Client roles to secure enabled Codex device login", () => {
    const instance = { driver: ProviderDriverKind.make("codex"), enabled: true };
    for (const role of ["owner", "client"]) {
      expect(canLoginProviderDeviceCode({ role, secureSecretTransport: true, instance })).toBe(
        true,
      );
      expect(canLoginProviderDeviceCode({ role, secureSecretTransport: false, instance })).toBe(
        false,
      );
      expect(
        canLoginProviderDeviceCode({ role, secureSecretTransport: true, instance: undefined }),
      ).toBe(false);
      expect(
        canLoginProviderDeviceCode({
          role,
          secureSecretTransport: true,
          instance: { ...instance, enabled: false },
        }),
      ).toBe(false);
      for (const driver of ["claudeAgent", "axiom"])
        expect(
          canLoginProviderDeviceCode({
            role,
            secureSecretTransport: true,
            instance: { driver: ProviderDriverKind.make(driver) },
          }),
        ).toBe(false);
    }
    for (const role of ["viewer", "member", "", "admin"])
      expect(canLoginProviderDeviceCode({ role, secureSecretTransport: true, instance })).toBe(
        false,
      );
    expect(canLoginProvider({ role: "client", secureSecretTransport: true, instance })).toBe(false);
  });
});
