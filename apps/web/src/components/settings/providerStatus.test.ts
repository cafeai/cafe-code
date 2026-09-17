import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { getProviderSummary } from "./providerStatus";

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
