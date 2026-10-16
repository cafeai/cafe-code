import { describe, expect, it } from "vitest";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import {
  isProviderInstanceMissingError,
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
} from "./ProviderCommandReactor.ts";
describe("provider error attribution", () => {
  it("uses the current provider instance slug when current instance lookup fails", () => {
    expect(
      providerErrorLabelFromInstanceHint({
        instanceId: "codex_personal",
        modelSelectionInstanceId: "codex",
        sessionProvider: "codex",
      }),
    ).toBe("codex_personal");
  });

  it("uses the desired provider instance slug when desired instance lookup fails", () => {
    expect(
      providerErrorLabelFromInstanceHint({
        instanceId: "claude_openrouter",
      }),
    ).toBe("claude_openrouter");
  });

  it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
    expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
  });

  it("preserves provider daemon transport failures as operational errors", () => {
    const error = new ProviderAdapterRequestError({
      provider: "provider-daemon",
      method: "getInstanceInfo",
      detail: "connect ECONNREFUSED /tmp/provider-daemon.sock",
    });

    expect(isProviderInstanceMissingError(error)).toBe(false);
  });

  it("recognizes a typed remote registry miss", () => {
    const error = new ProviderAdapterRequestError({
      provider: "provider-daemon",
      method: "getInstanceInfo",
      detail: "ProviderUnsupportedError: provider instance is not configured",
      remoteErrorTag: "ProviderUnsupportedError",
    });

    expect(isProviderInstanceMissingError(error)).toBe(true);
  });
});
