import "../../index.css";
import {
  EnvironmentId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  type ProviderSecurityReport,
  type ProviderSecurityResult,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { AxiomSecurityControl, axiomSecurityLabel } from "./AxiomSecurityControl";

const fixture = vi.hoisted(() => ({ subscribe: vi.fn(), refresh: vi.fn() }));
vi.mock("../../environments/runtime", () => ({
  requireEnvironmentConnection: () => ({
    client: {
      server: {
        subscribeProviderSecurity: fixture.subscribe,
        refreshProviderSecurity: fixture.refresh,
      },
    },
  }),
}));
vi.mock("../../lib/copyToClipboard", () => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve()),
}));
const input = {
  instanceId: ProviderInstanceId.make("axiom-personal"),
  threadId: ThreadId.make("axiom-chat"),
  runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001"),
  modelId: "test-model",
};
const props = { environmentId: EnvironmentId.make("local"), input, connected: true, idle: true };
const report = (): ProviderSecurityReport => {
  const now = Math.floor(Date.now() / 1000);
  return {
    runtimeId: input.runtimeId,
    modelId: input.modelId,
    providerId: "tinfoil",
    observedAt: new Date().toISOString(),
    attestation: { state: "verified" },
    reply: { state: "none" },
    evidence: {
      status: { state: "verified" },
      modelId: input.modelId,
      providerId: "tinfoil",
      attestationProtocol: "tinfoil-snp-sigstore-v1",
      e2eeProtocol: "tinfoil-ehbp-v1",
      e2eeEncryptionVersion: 1,
      trustPolicyVersion: "fixture-policy",
      verifiedAtUnixSeconds: now,
      hardExpiresAtUnixSeconds: now + 240,
      modelKeyFingerprint: "a".repeat(64),
      checks: [{ name: "SNP router", passed: true, detail: "Synthetic router evidence" }],
      providerClaims: [],
    },
  };
};
const publish = (value: ProviderSecurityReport | null) =>
  (fixture.subscribe.mock.calls.at(-1)![1] as (result: ProviderSecurityResult) => void)({
    report: value,
  });
const originalLocale = getUiLocale();
const originalClasses = document.documentElement.className;
const originalFontSize = document.documentElement.style.fontSize;
beforeEach(() => {
  setUiLocale("en");
  fixture.subscribe.mockReset().mockReturnValue(vi.fn());
  fixture.refresh.mockReset();
});
afterEach(() => {
  setUiLocale(originalLocale);
  document.documentElement.className = originalClasses;
  document.documentElement.style.fontSize = originalFontSize;
  applyInterfaceScalePercent(100);
  vi.clearAllMocks();
});

describe("Axiom composer attestation inspector", () => {
  it("shows scoped evidence, opens without a provider call, copies only public evidence and restores focus", async () => {
    await render(<AxiomSecurityControl {...props} />);
    await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(1);
    const value = report();
    publish(value);
    const trigger = page.getByRole("button", { name: "Attestation verified", exact: true });
    await trigger.click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("SNP router", { exact: true })).toBeVisible();
    expect(fixture.refresh).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Copy public report" }).click();
    expect(copyTextToClipboard).toHaveBeenCalledWith(JSON.stringify(value.evidence, null, 2));
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveFocus();
  });
  it("requires explicit current-model consent and keeps degraded evidence separate from reply authentication", async () => {
    await render(<AxiomSecurityControl {...props} />);
    await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(1);
    publish({
      ...report(),
      attestation: { state: "outdated" },
      providerId: "near",
      evidence: null,
    });
    await page.getByRole("button", { name: "Attestation needs review" }).click();
    const accept = page.getByRole("button", { name: "Accept outdated TEE", exact: true });
    await expect.element(accept).toBeDisabled();
    const degraded = {
      ...report(),
      attestation: { state: "degraded" as const },
      providerId: "near",
      evidence: {
        ...report().evidence!,
        status: { state: "degraded" as const },
        providerId: "near",
      },
    };
    fixture.refresh.mockResolvedValue({ report: degraded });
    await page.getByRole("checkbox").click();
    await accept.click();
    await expect.poll(() => fixture.refresh.mock.calls.length).toBe(1);
    expect(fixture.refresh).toHaveBeenCalledWith({ ...input, acceptOutdatedTee: true });
    await expect
      .element(page.getByText("Degraded attestation", { exact: true }).first())
      .toBeVisible();
    expect(axiomSecurityLabel(degraded, Math.floor(Date.now() / 1000))).not.toBe("Reply verified");
  });
  it("rejects retired callbacks and clears evidence across account/runtime changes and disconnect", async () => {
    const mounted = await render(<AxiomSecurityControl {...props} />);
    await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(1);
    const old = fixture.subscribe.mock.calls[0]![1] as (result: ProviderSecurityResult) => void;
    old({ report: report() });
    await expect.element(page.getByRole("button", { name: "Attestation verified" })).toBeVisible();
    await mounted.rerender(
      <AxiomSecurityControl
        {...props}
        input={{ ...input, instanceId: ProviderInstanceId.make("another-account") }}
      />,
    );
    old({ report: report() });
    await expect
      .element(page.getByRole("button", { name: "Verification unavailable" }))
      .toBeVisible();
    await mounted.rerender(<AxiomSecurityControl {...props} connected={false} />);
    await expect
      .element(page.getByRole("button", { name: "Verification unavailable" }))
      .toBeVisible();
  });
  it("does not promote expired reports or change authenticated replies when a report expires", () => {
    const value = report();
    expect(axiomSecurityLabel(value, value.evidence!.hardExpiresAtUnixSeconds)).toBe(
      "Report needs refresh",
    );
    expect(
      axiomSecurityLabel(
        { ...value, reply: { state: "verified", turnId: "turn", modelId: input.modelId } },
        value.evidence!.hardExpiresAtUnixSeconds,
      ),
    ).toBe("Reply verified");
    expect(
      axiomSecurityLabel(
        { ...value, reply: { state: "incomplete" } },
        Math.floor(Date.now() / 1000),
      ),
    ).toBe("Reply not verified");
  });
  it("discards a report for another native model or runtime", async () => {
    await render(<AxiomSecurityControl {...props} />);
    await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(1);
    publish({ ...report(), modelId: "another-model" });
    await expect
      .element(page.getByRole("button", { name: "Verification unavailable" }))
      .toBeVisible();
    publish({
      ...report(),
      runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000002"),
    });
    await expect
      .element(page.getByRole("button", { name: "Verification unavailable" }))
      .toBeVisible();
  });
  it("revokes checkbox consent when the report or connection scope changes", async () => {
    const mounted = await render(<AxiomSecurityControl {...props} />);
    await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(1);
    const outdated: ProviderSecurityReport = {
      ...report(),
      providerId: "near",
      attestation: { state: "outdated" },
      evidence: null,
    };
    publish(outdated);
    await page.getByRole("button", { name: "Attestation needs review" }).click();
    await page.getByRole("checkbox").click();
    await expect
      .element(page.getByRole("button", { name: "Accept outdated TEE", exact: true }))
      .toBeEnabled();
    await mounted.rerender(<AxiomSecurityControl {...props} connected={false} />);
    await mounted.rerender(<AxiomSecurityControl {...props} />);
    await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(2);
    publish(outdated);
    await expect.element(page.getByRole("checkbox")).not.toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Accept outdated TEE", exact: true }))
      .toBeDisabled();
    expect(fixture.refresh).not.toHaveBeenCalled();
  });
  it.each([
    { dark: false, scale: 80, locale: "ja" as const },
    { dark: true, scale: 130, locale: "ko" as const },
    { dark: true, scale: 100, locale: "en" as const },
  ])(
    "fits narrow theme=$dark scale=$scale locale=$locale with separate reply and attestation states",
    async ({ dark, scale, locale }) => {
      document.documentElement.classList.toggle("dark", dark);
      applyInterfaceScalePercent(scale);
      setUiLocale(locale);
      await page.viewport(locale === "en" ? 960 : 430, 740);
      await render(<AxiomSecurityControl {...props} />);
      await expect.poll(() => fixture.subscribe.mock.calls.length).toBe(1);
      publish({
        ...report(),
        reply: { state: "verified", turnId: "fixture-turn", modelId: input.modelId },
      });
      await page
        .getByRole("button", {
          name: uiText("Reply verified", undefined, undefined, locale),
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog").element();
      await vi.waitFor(() => {
        expect(dialog.hasAttribute("data-starting-style")).toBe(false);
        expect(
          dialog.getAnimations().every((animation) => animation.playState === "finished"),
        ).toBe(true);
      });
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      await expect
        .element(page.getByText(uiText("Latest reply verification", undefined, undefined, locale)))
        .toBeVisible();
      await expect
        .element(page.getByText(uiText("Cached attestation report", undefined, undefined, locale)))
        .toBeVisible();
      expect(fixture.refresh).not.toHaveBeenCalled();
      const directory = import.meta.env.VITE_AXIOM_SCREENSHOT_DIR;
      if (typeof directory === "string" && directory.length > 0)
        await page.screenshot({ path: `${directory}/axiom-verification-${locale}.png` });
    },
  );
});
