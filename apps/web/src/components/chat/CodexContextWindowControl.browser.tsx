import "../../index.css";
import { useState } from "react";
import { ProviderDriverKind } from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import {
  deriveCodexContextWindowPresentation,
  formatCodexContextWindowTokens,
  formatCodexContextCompactionEstimate,
} from "../../codexContextWindow";
import { MenuItem } from "../ui/menu";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { CodexContextWindowControl } from "./CodexContextWindowControl";

function Harness(props: {
  onChange: (value: number | null) => Promise<void>;
  override?: number | null;
  configured?: number | null;
  inherited?: number;
  requestedAutoCompactTokenLimit?: number;
  configuredAutoCompactTokenLimit?: number | null;
  pairedSupported?: boolean;
  supported?: boolean;
  provider?: "codex" | "claudeAgent";
}) {
  const [open, setOpen] = useState(false);
  const supported = props.supported ?? true;
  const provider = props.provider ?? "codex";
  const presentation = deriveCodexContextWindowPresentation({
    requested: props.override,
    configured: props.configured,
    inherited: props.inherited,
    requestedAutoCompactTokenLimit: props.requestedAutoCompactTokenLimit,
    configuredAutoCompactTokenLimit: props.configuredAutoCompactTokenLimit,
    canApplyWhenIdle: supported && props.pairedSupported !== false,
  });
  return (
    <>
      <CompactComposerControlsMenu
        showPlanSidebar={false}
        provider={ProviderDriverKind.make(provider)}
        interactionMode="default"
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        showInteractionModeToggle
        onToggleInteractionMode={() => {}}
        onNativePermissionModeChange={() => {}}
        onTogglePlanSidebar={() => {}}
        onRuntimeModeChange={() => {}}
        subagentConcurrencyControl={<MenuItem>Subagent limit…</MenuItem>}
        codexContextWindowControl={
          provider === "codex" ? (
            <MenuItem
              disabled={
                (!supported || props.pairedSupported === false) &&
                props.override == null &&
                props.configured == null &&
                presentation.requested === null
              }
              onClick={() => setOpen(true)}
            >
              Context window…
            </MenuItem>
          ) : null
        }
      />
      {provider === "codex" ? (
        <CodexContextWindowControl
          open={open}
          onOpenChange={setOpen}
          supported={supported && props.pairedSupported !== false}
          override={props.override}
          presentation={presentation}
          onChange={props.onChange}
        />
      ) : null}
    </>
  );
}

async function openEditor() {
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Context window…", exact: true }).click();
  await expect
    .element(page.getByRole("dialog", { name: "Context window", exact: true }))
    .toBeVisible();
}

describe("Codex context-window editor", () => {
  const originalLocale = getUiLocale();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const fontSize = document.documentElement.style.fontSize;
  const originalDark = document.documentElement.classList.contains("dark");
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  beforeEach(() => setUiLocale("en"));
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
    document.documentElement.style.fontSize = fontSize;
    document.documentElement.classList.toggle("dark", originalDark);
    await page.viewport(viewport.width, viewport.height);
    setUiLocale(originalLocale);
  });

  it("places context after Subagent limit and before Mode, and hides it for other providers", async () => {
    mounted = await render(<Harness onChange={async () => {}} />);
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    const menu = page.getByRole("menu").element();
    const labels = menu.textContent!;
    expect(labels.indexOf("Subagent limit…")).toBeLessThan(labels.indexOf("Context window…"));
    expect(labels.indexOf("Context window…")).toBeLessThan(labels.indexOf("Mode"));
    await userEvent.keyboard("{Escape}");
    await mounted.rerender(<Harness provider="claudeAgent" onChange={async () => {}} />);
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Context window…", exact: true }))
      .not.toBeInTheDocument();
  });

  it.each(["0", "-1", "1.5", "9007199254740992"])(
    "rejects %s before any metadata write",
    async (value) => {
      const onChange = vi.fn(async () => {});
      mounted = await render(<Harness onChange={onChange} />);
      await openEditor();
      await page
        .getByRole("spinbutton", { name: "Context window (tokens)", exact: true })
        .fill(value);
      await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(
          "Enter a positive whole token count within the supported numeric range.",
        );
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each(["blank", "Reset"])(
    "saves %s as explicit inheritance without copying the account default",
    async (action) => {
      const onChange = vi.fn(async () => {});
      mounted = await render(
        <Harness onChange={onChange} override={500_000} configured={500_000} inherited={700_000} />,
      );
      await openEditor();
      if (action === "blank")
        await page
          .getByRole("spinbutton", { name: "Context window (tokens)", exact: true })
          .fill("");
      await page
        .getByRole("button", { name: action === "blank" ? "Save" : "Reset", exact: true })
        .click();
      expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("preserves editable input and generic failure across locale and canonical updates without replay", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("private provider diagnostic");
    });
    mounted = await render(<Harness onChange={onChange} override={500_000} configured={500_000} />);
    await openEditor();
    await page
      .getByRole("spinbutton", { name: "Context window (tokens)", exact: true })
      .fill("1000000");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not save this chat’s context override. Try again when connected.");
    await mounted.rerender(<Harness onChange={onChange} override={600_000} configured={500_000} />);
    for (const locale of ["ja", "ko", "en"] as const) {
      setUiLocale(locale);
      await expect
        .element(
          page.getByRole("spinbutton", {
            name: uiText("Context window (tokens)", undefined, undefined, locale),
            exact: true,
          }),
        )
        .toHaveValue(1_000_000);
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(
          uiText(
            "Could not save this chat’s context override. Try again when connected.",
            undefined,
            undefined,
            locale,
          ),
        );
    }
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1_000_000);
    expect(document.body.textContent).not.toContain("private provider diagnostic");
  });

  it("explains live account inheritance on keyboard focus while preserving blank input", async () => {
    mounted = await render(
      <Harness onChange={async () => {}} inherited={600_000} configured={500_000} />,
    );
    await openEditor();
    await expect
      .element(page.getByText("Context override: 500K → 600K when idle", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("spinbutton", { name: "Context window (tokens)", exact: true }))
      .toHaveValue(null);
    page
      .getByRole("spinbutton", { name: "Context window (tokens)", exact: true })
      .element()
      .focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "About context-window overrides", exact: true }).element(),
    );
    await expect.element(page.getByText("Source: Account default.", { exact: true })).toBeVisible();
    expect(document.body.textContent).toContain("not verified model capacity");
  });

  it("revokes numeric save after capability loss but leaves Reset available", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} override={500_000} configured={500_000} />);
    await openEditor();
    await mounted.rerender(
      <Harness onChange={onChange} override={500_000} configured={500_000} supported={false} />,
    );
    await expect
      .element(page.getByRole("spinbutton", { name: "Context window (tokens)", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("keeps compaction estimates beside exact saved/pending labels and explains the safe opening rather than applied usage", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(
      <Harness
        onChange={onChange}
        override={800_000}
        configured={500_000}
        requestedAutoCompactTokenLimit={150_000}
      />,
    );
    await openEditor();
    await expect
      .element(page.getByText("Context override: 500K → 800K when idle", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("(~150K compaction)", { exact: true })).toBeVisible();
    page
      .getByRole("spinbutton", { name: "Context window (tokens)", exact: true })
      .element()
      .focus();
    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByText("Source: Chat override.", { exact: true })).toBeVisible();
    expect(document.body.textContent).toContain("next safe opening");
    expect(document.body.textContent).toContain(
      "not a currently applied or native-reported threshold",
    );
    expect(document.body.textContent).toContain("default total-scope 90% ceiling");
    expect(document.body.textContent).toContain(
      "model caps, accounting scope and buffers may differ",
    );
    await mounted.rerender(
      <Harness onChange={onChange} override={800_000} requestedAutoCompactTokenLimit={900_000} />,
    );
    await expect
      .element(page.getByText("Context override: 800K · saved", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("(~720K compaction)", { exact: true })).toBeVisible();
    await mounted.rerender(
      <Harness onChange={onChange} override={null} configured={800_000} inherited={600_000} />,
    );
    await expect
      .element(page.getByText("Context override: 800K → 600K when idle", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("(~540K compaction)", { exact: true })).toBeVisible();
    await mounted.rerender(
      <Harness
        onChange={onChange}
        override={null}
        configured={800_000}
        requestedAutoCompactTokenLimit={150_000}
      />,
    );
    await expect
      .element(page.getByText("Context override: 800K → Codex default when idle", { exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-codex-context-compaction-estimate]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["en", "ja", "ko"] as const)(
    "distinguishes same-context pending compaction and context-only legacy support in %s without changing saved intent",
    async (locale) => {
      setUiLocale(locale);
      const onChange = vi.fn(async () => {});
      const view = (proof: number | null | undefined, pairedSupported = true) => (
        <Harness
          onChange={onChange}
          override={800_000}
          configured={800_000}
          {...(proof !== undefined ? { configuredAutoCompactTokenLimit: proof } : {})}
          pairedSupported={pairedSupported}
        />
      );
      mounted = await render(view(undefined));
      // Use the real editor button/keyboard path; no action applies the nominal
      // companion in this renderer-only fixture or rewrites the saved choice.
      const presentation = (proof: number | null | undefined, supported = true) =>
        deriveCodexContextWindowPresentation({
          requested: 800_000,
          configured: 800_000,
          configuredAutoCompactTokenLimit: proof,
          canApplyWhenIdle: supported,
        });
      // The Harness menu labels are fixture-owned English; production details
      // inside the retained dialog use the actual active locale.
      await page
        .getByRole("button", {
          name: uiText("More composer controls", undefined, undefined, locale),
          exact: true,
        })
        .click();
      await page.getByRole("menuitem", { name: "Context window…", exact: true }).click();
      const label = uiText(
        "Context override: {tokens} · compaction when idle",
        {
          tokens: formatCodexContextWindowTokens(800_000, locale),
        },
        undefined,
        locale,
      );
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
      await expect
        .element(
          page.getByText(formatCodexContextCompactionEstimate(presentation(undefined), locale)!, {
            exact: true,
          }),
        )
        .toBeVisible();
      await mounted.rerender(view(800_000));
      await expect
        .element(
          page.getByText(
            uiText(
              "Context override: {tokens}",
              {
                tokens: formatCodexContextWindowTokens(800_000, locale),
              },
              undefined,
              locale,
            ),
            { exact: true },
          ),
        )
        .toBeVisible();
      const input = page.getByRole("spinbutton", {
        name: uiText("Context window (tokens)", undefined, undefined, locale),
        exact: true,
      });
      await input.fill("900000");
      await mounted.rerender(view(null, false));
      await expect
        .element(
          page.getByText(
            uiText(
              "Context override: {tokens} · saved",
              {
                tokens: formatCodexContextWindowTokens(800_000, locale),
              },
              undefined,
              locale,
            ),
            { exact: true },
          ),
        )
        .toBeVisible();
      await expect.element(input).toBeDisabled();
      await expect.element(input).toHaveValue(900_000);
      await expect
        .element(
          page.getByRole("button", {
            name: uiText("Save", undefined, undefined, locale),
            exact: true,
          }),
        )
        .toBeDisabled();
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    { dark: false, scale: 80, locale: "ja" as const },
    { dark: true, scale: 130, locale: "ko" as const },
  ])(
    "fits a narrow $locale dialog in theme=$dark scale=$scale with native compact token labels",
    async ({ dark, scale, locale }) => {
      document.documentElement.classList.toggle("dark", dark);
      applyInterfaceScalePercent(scale);
      setUiLocale(locale);
      await page.viewport(430, 680);
      mounted = await render(
        <CodexContextWindowControl
          open
          onOpenChange={() => {}}
          supported
          override={1_000_000}
          presentation={deriveCodexContextWindowPresentation({
            requested: 1_000_000,
            configured: 500_000,
          })}
          onChange={async () => {}}
        />,
      );
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
      expect(document.body.textContent).toContain(
        formatCodexContextWindowTokens(1_000_000, locale),
      );
      const estimate = page.getByText(
        formatCodexContextCompactionEstimate(
          deriveCodexContextWindowPresentation({ requested: 1_000_000, configured: 500_000 }),
          locale,
        )!,
        { exact: true },
      );
      await expect.element(estimate).toBeVisible();
      const summary = estimate
        .element()
        .closest<HTMLElement>("[data-codex-context-window-details]")!;
      const estimateStyle = getComputedStyle(estimate.element());
      expect(estimateStyle.color).not.toBe(getComputedStyle(summary.querySelector("span")!).color);
      expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
      expect(summary.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
      expect(summary.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      await expect
        .element(
          page.getByRole("button", {
            name: uiText("Save", undefined, undefined, locale),
            exact: true,
          }),
        )
        .toBeVisible();
      const screenshotDirectory = import.meta.env.VITE_CODEX_CONTEXT_SCREENSHOT_DIR;
      if (typeof screenshotDirectory === "string" && screenshotDirectory.length > 0) {
        await page.screenshot({
          path: `${screenshotDirectory}/context-dialog-${dark ? "dark" : "light"}-${scale}-${locale}.png`,
        });
      }
    },
  );
});
