import "../../index.css";
import { useState } from "react";
import { ProviderDriverKind } from "@cafecode/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MenuItem } from "../ui/menu";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { SubagentConcurrencyControl } from "./SubagentConcurrencyControl";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import type { SubagentConcurrencyPresentation } from "../../subagentConcurrency";

function Harness(props: {
  onChange: (value: number | undefined) => Promise<void>;
  supported?: boolean;
  running?: boolean;
  provider?: "codex" | "claudeAgent";
  configured?: number | null;
  override?: number | undefined;
  presentationRequested?: number | undefined;
  presentationSource?: SubagentConcurrencyPresentation["source"];
  presentationPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const provider = ProviderDriverKind.make(props.provider ?? "codex");
  const supported = props.supported ?? true;
  const requested = props.presentationRequested ?? props.override;
  return (
    <>
      <CompactComposerControlsMenu
        showPlanSidebar={false}
        provider={provider}
        interactionMode="default"
        planSidebarLabel="Plan"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        showInteractionModeToggle={false}
        onToggleInteractionMode={() => {}}
        onNativePermissionModeChange={() => {}}
        onTogglePlanSidebar={() => {}}
        onRuntimeModeChange={() => {}}
        subagentConcurrencyControl={
          <MenuItem
            disabled={!supported && props.override === undefined}
            onClick={() => setOpen(true)}
          >
            Subagent limit…
          </MenuItem>
        }
      />
      <SubagentConcurrencyControl
        open={open}
        onOpenChange={setOpen}
        provider={provider}
        supported={supported}
        override={props.override}
        isRunning={props.running ?? false}
        onChange={props.onChange}
        presentation={{
          requested,
          configured: props.configured,
          source:
            props.presentationSource ??
            (props.override === undefined ? "Provider / inherited default" : "Chat override"),
          pending:
            props.presentationPending ??
            (props.configured !== undefined && (requested ?? null) !== props.configured),
        }}
      />
    </>
  );
}

async function openEditor() {
  await page.getByRole("button", { name: "More composer controls" }).click();
  await page.getByRole("menuitem", { name: "Subagent limit…", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
}

describe("per-chat subagent concurrency editor", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const fontSize = document.documentElement.style.fontSize;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
    document.documentElement.style.fontSize = fontSize;
    await page.viewport(viewport.width, viewport.height);
  });
  it("shows one saved limit while application is pending and explains it in accessible help", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} override={5} configured={3} running />);
    await openEditor();
    await expect
      .element(page.getByText("Subagent limit: 3 → 5 when idle", { exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-subagent-concurrency-details]")?.textContent).toBe(
      "Subagent limit: 3 → 5 when idle",
    );
    expect(document.body.textContent).not.toContain("Source:");
    expect(document.body.textContent).not.toContain("Native effective limit is not verified.");

    const information = page.getByRole("button", { name: "About subagent limits" });
    const tooltipCopy =
      "Shows Cafe’s recorded session setting and requested setting. Changes wait for a safe idle turn; active children can delay them. Cafe can’t independently confirm the limit the provider enforces.";
    const tooltip = page.getByText(tooltipCopy, { exact: true });
    page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(information.element());
    await expect.element(tooltip).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect.element(tooltip).not.toBeInTheDocument();
    await information.hover();
    await expect.element(tooltip).toBeVisible();

    await page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("24");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(24);
  });
  it.each(["0", "65", "1.5"])("rejects invalid %s without a write", async (value) => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} />);
    await openEditor();
    await page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill(value);
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Enter a whole number from 1 to 64.");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("resets only the requested override and leaves native default unknown", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(
      <Harness onChange={onChange} provider="claudeAgent" override={20} configured={null} />,
    );
    await openEditor();
    await expect
      .element(page.getByText("Subagent limit: Provider default → 20 when idle", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Provider-managed");
    // Provider-specific scope notes live in the one labelled info tooltip.
    // A visible mobile dialog can still be entering. A one-shot hover during
    // that movement leaves the small trigger and cancels the native tooltip
    // rest timer. Admit the actual settled target, not an arbitrary delay;
    // retain the real hover, exact help text and reset-authority assertions.
    const dialog = page.getByRole("dialog").element();
    await vi.waitFor(() => {
      expect(dialog.hasAttribute("data-starting-style")).toBe(false);
      expect(dialog.getAnimations().every((animation) => animation.playState === "finished")).toBe(
        true,
      );
    });
    await page.getByRole("button", { name: "About subagent limits" }).hover();
    await expect.element(page.getByText(/Claude limits Agent-tool admission/)).toBeVisible();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("shows a numeric inherited account setting as a single limit", async () => {
    mounted = await render(
      <Harness
        onChange={async () => {}}
        presentationRequested={5}
        presentationSource="Legacy instance configuration"
        configured={5}
      />,
    );
    await openEditor();
    await expect.element(page.getByText("Subagent limit: 5", { exact: true })).toBeVisible();
    expect(document.querySelector("[data-subagent-concurrency-details]")?.textContent).toBe(
      "Subagent limit: 5",
    );
  });

  it("explains account inheritance and current configuration without promising a busy next turn", async () => {
    mounted = await render(
      <Harness
        onChange={async () => {}}
        presentationRequested={15}
        presentationSource="Account default"
        configured={5}
        running
      />,
    );
    await openEditor();
    await expect
      .element(page.getByText("Subagent limit: 5 → 15 when idle", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
      .toHaveValue(null);
    const dialog = page.getByRole("dialog").element();
    await vi.waitFor(() => expect(dialog.hasAttribute("data-starting-style")).toBe(false));
    await page.getByRole("button", { name: "About subagent limits" }).hover();
    await expect.element(page.getByText("Source: Account default.", { exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Current session was configured with 5. The requested setting is pending a safe idle turn.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("Your current work won’t be interrupted.", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("next turn");
  });
  it("gates an older unsupported runtime without presenting an enabled editor", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} supported={false} />);
    await page.getByRole("button", { name: "More composer controls" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Subagent limit…", exact: true }))
      .toBeDisabled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("blocks numeric writes but preserves reset if a capability is revoked while open", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} override={12} />);
    await openEditor();
    await mounted.rerender(<Harness onChange={onChange} override={12} supported={false} />);
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Reset", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("allows clearing a remembered request on an unsupported runtime without a numeric save", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} override={12} supported={false} />);
    await openEditor();
    await expect
      .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect.element(page.getByText(/This account can’t apply a numeric limit/)).toBeVisible();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it("preserves an in-progress edit across metadata updates and reads fresh state on reopening", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} override={12} />);
    await openEditor();
    const input = page.getByRole("spinbutton", { name: "Maximum concurrent subagents" });
    await input.fill("24");
    await mounted.rerender(<Harness onChange={onChange} override={20} />);
    await expect.element(input).toHaveValue(24);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openEditor();
    await expect.element(input).toHaveValue(20);
    expect(onChange).not.toHaveBeenCalled();
  });
  it.each([undefined, 64])(
    "keeps the editor available and bounded at 320px with 130%% scaling for saved limit %s",
    async (limit) => {
      await page.viewport(320, 800);
      applyInterfaceScalePercent(130);
      mounted = await render(<Harness onChange={async () => {}} override={limit} />);
      await openEditor();
      if (limit === undefined) {
        expect(document.querySelector("[data-subagent-concurrency-details]")).toBeNull();
      } else {
        await expect
          .element(page.getByText("Subagent limit: 64 · saved", { exact: true }))
          .toBeVisible();
      }
      await expect
        .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
        .toBeEnabled();
      await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      const box = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    },
  );
  it.each([
    { requested: 15, configured: 5, label: "Subagent limit: 5 → 15 when idle" },
    {
      requested: undefined,
      configured: 15,
      label: "Subagent limit: 15 → Provider default when idle",
    },
  ])(
    "contains the compact transition $label at 320px and 130% scale",
    async ({ requested, configured, label }) => {
      await page.viewport(320, 800);
      applyInterfaceScalePercent(130);
      mounted = await render(
        <Harness
          onChange={async () => {}}
          presentationRequested={requested}
          configured={configured}
          presentationSource="Account default"
        />,
      );
      await openEditor();
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
      expect(document.querySelectorAll("[data-subagent-concurrency-details]")).toHaveLength(1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      const details = document.querySelector<HTMLElement>("[data-subagent-concurrency-details]")!;
      expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth + 1);
      const box = page.getByRole("dialog").element().getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    },
  );
  it("keeps the saved label on a failed write while retaining the edit and a generic error", async () => {
    mounted = await render(
      <Harness
        onChange={async () => {
          throw new Error("private provider detail");
        }}
        override={12}
        configured={3}
      />,
    );
    await openEditor();
    await page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }).fill("24");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not save this chat's subagent limit. Try again when connected.");
    expect(document.body.textContent).not.toContain("private provider detail");
    await expect
      .element(page.getByText("Subagent limit: 3 → 12 when idle", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("spinbutton", { name: "Maximum concurrent subagents" }))
      .toHaveValue(24);
  });
});
