import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { PROVIDER_STATUS_STYLES, getProviderSummary } from "./providerStatus";

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("grok"),
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
    installed: true,
    version: "1.0.34",
    status: "error",
    auth: { status: "unknown" },
    checkedAt: "2026-09-17T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("Codex subscription provider summary", () => {
  it.each([
    "ChatGPT Plus Subscription",
    "ChatGPT Pro Subscription",
    "ChatGPT Pro (More) Subscription",
    "ChatGPT Pro (Max) Subscription",
    // Cached labels from older backends stay displayable until fresh metadata.
    "ChatGPT Pro 5x Subscription",
    "ChatGPT Pro 20x Subscription",
  ])("preserves the server-reported %s label", (label) => {
    expect(
      getProviderSummary(
        makeProvider({
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          auth: { status: "authenticated", type: "chatgpt", label },
        }),
      ),
    ).toEqual({ headline: `Authenticated · ${label}`, detail: null });
  });

  it("keeps the generic subscription label when the server cannot establish a tier", () => {
    expect(
      getProviderSummary(
        makeProvider({
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          auth: {
            status: "authenticated",
            type: "chatgpt",
            label: "ChatGPT Subscription",
          },
        }),
      ).headline,
    ).toBe("Authenticated · ChatGPT Subscription");
  });
});

describe("Grok sandbox provider summary", () => {
  it("uses the typed sandbox failure even when authentication was previously verified", () => {
    expect(
      getProviderSummary(
        makeProvider({
          auth: { status: "authenticated" },
          sandbox: { status: "unavailable", reason: "container-socket-symlink" },
        }),
      ),
    ).toEqual({
      headline: "Sandbox unavailable",
      detail: "Grok could not start its protected connection check.",
    });
  });

  it("does not infer sandbox capability from an arbitrary error message", () => {
    expect(getProviderSummary(makeProvider({ message: "sandbox startup failed" })).headline).toBe(
      "Unavailable",
    );
  });

  it.each([
    { enabled: false, expected: "Disabled" },
    { installed: false, expected: "Not found" },
  ])("keeps $expected ahead of a retained sandbox diagnostic", ({ expected, ...overrides }) => {
    expect(
      getProviderSummary(makeProvider({ sandbox: { status: "unavailable" }, ...overrides }))
        .headline,
    ).toBe(expected);
  });
});

describe("provider status summary copy", () => {
  it("shows a short neutral checking state before the server reports a provider", () => {
    expect(getProviderSummary(undefined)).toEqual({ headline: "Checking…", detail: null });
    expect(PROVIDER_STATUS_STYLES.checking.dot).toContain("bg-status-idle");
    expect(PROVIDER_STATUS_STYLES.checking.dot).toContain("animate-pulse");
    expect(PROVIDER_STATUS_STYLES.checking.dot).not.toMatch(/warning|amber/);
  });

  it("uses neutral grey for disabled providers without restating the switch", () => {
    expect(getProviderSummary(makeProvider({ enabled: false }))).toEqual({
      headline: "Disabled",
      detail: null,
    });
    expect(PROVIDER_STATUS_STYLES.disabled.dot).toBe("bg-status-idle");
  });

  it("reports an unverified sign-in when a ready provider omits authentication state", () => {
    expect(
      getProviderSummary(
        makeProvider({
          driver: ProviderDriverKind.make("codex"),
          status: "ready",
          auth: { status: "unknown" },
        }),
      ),
    ).toEqual({ headline: "Sign-in not verified", detail: null });
  });

  it("keeps server-supplied detail for every state", () => {
    expect(getProviderSummary(makeProvider({ enabled: false, message: "Off by policy" }))).toEqual({
      headline: "Disabled",
      detail: "Off by policy",
    });
    expect(
      getProviderSummary(
        makeProvider({ status: "ready", auth: { status: "unknown" }, message: "Account ready" }),
      ).detail,
    ).toBe("Account ready");
  });
});
