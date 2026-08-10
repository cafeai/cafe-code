import {
  DEFAULT_LM_STUDIO_BASE_URL,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProviderCreationConfig,
  deriveProviderCreationInstanceId,
  LM_STUDIO_LOCAL_DISPLAY_NAME,
  LM_STUDIO_PROVIDER_TEMPLATE_ID,
  validateProviderCreationInstanceId,
} from "./providerInstanceCreation";

const codexDriver = ProviderDriverKind.make("codex");

describe("LM Studio provider instance creation", () => {
  it("creates a distinct local Codex instance with the safe loopback default", () => {
    expect(
      buildProviderCreationConfig({
        templateId: LM_STUDIO_PROVIDER_TEMPLATE_ID,
        driver: codexDriver,
        label: "",
        accentColor: "#00ff88",
        config: {},
      }),
    ).toEqual({
      driver: codexDriver,
      enabled: true,
      displayName: LM_STUDIO_LOCAL_DISPLAY_NAME,
      accentColor: "#00ff88",
      config: {
        ossMode: true,
        ossBaseUrl: DEFAULT_LM_STUDIO_BASE_URL,
      },
    } satisfies ProviderInstanceConfig);
  });

  it("preserves a user-supplied private LAN endpoint", () => {
    expect(
      buildProviderCreationConfig({
        templateId: LM_STUDIO_PROVIDER_TEMPLATE_ID,
        driver: codexDriver,
        label: "Studio Upstairs",
        accentColor: "",
        config: { ossBaseUrl: "http://192.168.50.12:1234/v1" },
      }),
    ).toMatchObject({
      displayName: "Studio Upstairs",
      config: {
        ossMode: true,
        ossBaseUrl: "http://192.168.50.12:1234/v1",
      },
    });
  });

  it("derives stable local instance IDs and rejects collisions", () => {
    expect(deriveProviderCreationInstanceId(LM_STUDIO_PROVIDER_TEMPLATE_ID, codexDriver, "")).toBe(
      "lmstudio",
    );
    expect(
      deriveProviderCreationInstanceId(
        LM_STUDIO_PROVIDER_TEMPLATE_ID,
        codexDriver,
        "Studio Upstairs",
      ),
    ).toBe("lmstudio_studio_upstairs");
    expect(validateProviderCreationInstanceId("lmstudio", new Set(["lmstudio"]))).toMatch(
      /already exists/i,
    );
  });
});
