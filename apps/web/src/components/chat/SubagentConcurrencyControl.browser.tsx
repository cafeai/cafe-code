import "../../index.css";
import { useState } from "react";
import { ProviderDriverKind } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MenuItem } from "../ui/menu";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { SubagentConcurrencyControl } from "./SubagentConcurrencyControl";
import { applyInterfaceScalePercent } from "../../interfaceScale";

function Harness(props: {
  onChange: (value: number | undefined) => Promise<void>;
  supported?: boolean;
  running?: boolean;
  provider?: "codex" | "claudeAgent";
  configured?: number | null;
  override?: number;
}) {
  const [open, setOpen] = useState(false);
  const provider = ProviderDriverKind.make(props.provider ?? "codex");
  const supported = props.supported ?? true;
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
          requested: props.override,
          configured: props.configured,
          source: "Chat override",
          pending: props.configured !== undefined && props.override !== props.configured,
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
  it("survives menu dismissal and saves a bounded explicit number without native-effect claims", async () => {
    const onChange = vi.fn(async () => {});
    mounted = await render(<Harness onChange={onChange} override={12} configured={3} running />);
    await openEditor();
    await expect.element(page.getByText("Configured: 3", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Pending until a safe idle session boundary.", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Native effective limit is not verified.", { exact: true }))
      .toBeVisible();
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
      .element(page.getByText("Configured: No Cafe numeric override", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/Claude limits Agent-tool admission/)).toBeVisible();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
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
    await expect
      .element(page.getByText(/This runtime cannot apply a numeric override/))
      .toBeVisible();
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
  it("shows unknown configuration and stays bounded at 320px with 130% scaling", async () => {
    await page.viewport(320, 800);
    applyInterfaceScalePercent(130);
    mounted = await render(<Harness onChange={async () => {}} />);
    await openEditor();
    await expect.element(page.getByText("Configured: Unknown", { exact: true })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const box = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
  });
  it("keeps a failed save visible with a generic error and no false configured update", async () => {
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
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not save this chat's subagent limit. Try again when connected.");
    expect(document.body.textContent).not.toContain("private provider detail");
    await expect.element(page.getByText("Configured: 3", { exact: true })).toBeVisible();
  });
});
