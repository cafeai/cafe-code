import type { ServerProvider } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  codexAuthWithSubscriptionPlan,
  formatCodexSubscriptionLabel,
} from "./codexSubscription.ts";

describe("Codex subscription presentation", () => {
  it.each([
    ["plus", "ChatGPT Plus Subscription"],
    ["prolite", "ChatGPT Pro 100 Subscription"],
    ["pro", "ChatGPT Pro 200 Subscription"],
    ["promax", "ChatGPT Pro 500 Subscription"],
    ["free", "ChatGPT Free Subscription"],
    ["go", "ChatGPT Go Subscription"],
    ["team", "ChatGPT Business Subscription"],
    ["self_serve_business_usage_based", "ChatGPT Business Subscription"],
    ["self_serve_business_prolite", "ChatGPT Business Premium Subscription"],
    ["business", "ChatGPT Enterprise Subscription"],
    ["enterprise_cbp_automation", "ChatGPT Enterprise (Automation) Subscription"],
    ["enterprise_cbp_usage_based", "ChatGPT Enterprise Subscription"],
    ["enterprise", "ChatGPT Enterprise Subscription"],
    ["edu", "ChatGPT Edu Subscription"],
    ["edu_plus", "ChatGPT Edu Plus Subscription"],
    ["edu_pro", "ChatGPT Edu Pro Subscription"],
    ["sci", "ChatGPT Academic Researchers Subscription"],
    ["sci_plus", "ChatGPT Academic Researchers Plus Subscription"],
    ["ent26", "ChatGPT Enterprise Subscription"],
  ])("formats the reported %s tier", (plan, label) => {
    expect(formatCodexSubscriptionLabel(plan)).toBe(label);
  });

  it.each([undefined, null, "unknown", "future_plan", "__proto__", "constructor", "toString", 20])(
    "does not guess or echo unsupported metadata %s",
    (plan) => {
      expect(formatCodexSubscriptionLabel(plan)).toBe("ChatGPT Subscription");
    },
  );

  const auth = {
    status: "authenticated",
    type: "chatgpt",
    label: "ChatGPT Pro 200 Subscription",
    email: "subscriber@example.com",
  } as const satisfies ServerProvider["auth"];

  it("updates only the label and preserves account identity", () => {
    expect(codexAuthWithSubscriptionPlan(auth, "prolite")).toEqual({
      ...auth,
      label: "ChatGPT Pro 100 Subscription",
    });
    expect(codexAuthWithSubscriptionPlan(auth, "promax")).toEqual({
      ...auth,
      label: "ChatGPT Pro 500 Subscription",
    });
    expect(codexAuthWithSubscriptionPlan(auth, "pro")).toBe(auth);
  });

  it.each([
    "ChatGPT Pro 5x Subscription",
    "ChatGPT Pro 20x Subscription",
    "ChatGPT Pro Subscription",
    "ChatGPT Pro (More) Subscription",
    "ChatGPT Pro (Max) Subscription",
  ])("retains cached legacy presentation %s until a current plan is reported", (label) => {
    const cachedAuth = { ...auth, label };
    expect(codexAuthWithSubscriptionPlan(cachedAuth, undefined)).toBe(cachedAuth);
    expect(codexAuthWithSubscriptionPlan(cachedAuth, null)).toBe(cachedAuth);
    expect(codexAuthWithSubscriptionPlan(cachedAuth, "promax")).toEqual({
      ...cachedAuth,
      label: "ChatGPT Pro 500 Subscription",
    });
  });

  it("keeps known presentation on missing sparse metadata, not on an unknown tier", () => {
    expect(codexAuthWithSubscriptionPlan(auth, undefined)).toBe(auth);
    expect(codexAuthWithSubscriptionPlan(auth, null)).toBe(auth);
    expect(codexAuthWithSubscriptionPlan(auth, "unknown")).toEqual({
      ...auth,
      label: "ChatGPT Subscription",
    });
    expect(codexAuthWithSubscriptionPlan(auth, "future_plan").label).toBe("ChatGPT Subscription");
  });

  it.each([
    { status: "unauthenticated", type: "chatgpt" },
    { status: "unknown", type: "chatgpt" },
    { status: "authenticated", type: "apiKey", label: "OpenAI API Key" },
    { status: "authenticated", type: "amazonBedrock", label: "Amazon Bedrock" },
    { status: "authenticated" },
  ] satisfies ServerProvider["auth"][])(
    "never promotes or relabels other authentication: %j",
    (other) => {
      expect(codexAuthWithSubscriptionPlan(other, "pro")).toBe(other);
      expect(codexAuthWithSubscriptionPlan(other, "promax")).toBe(other);
    },
  );
});
