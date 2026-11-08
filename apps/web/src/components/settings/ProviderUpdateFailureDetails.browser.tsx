import "../../index.css";
import { useSyncExternalStore } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@cafecode/contracts";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { page } from "vitest/browser";
import { ownNotificationFixture } from "../notificationFixture.test.fixture";

const fixture = vi.hoisted(() => ({
  environmentId: "server-a" as string | null,
  listeners: new Set<() => void>(),
}));
vi.mock("../../environments/workspace", () => ({
  readWorkspaceEnvironmentId: () => fixture.environmentId,
  useWorkspaceEnvironmentId: () =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
      () => fixture.environmentId,
    ),
}));
import { ProviderUpdateFailureDetails } from "./ProviderUpdateFailureDetails";

const originalLocale = getUiLocale();
let activeOwner: ReturnType<typeof ownNotificationFixture> | undefined;
function own(context: TestContext) {
  if (activeOwner) throw new Error("Previous update-details fixture is still retiring.");
  const owner = ownNotificationFixture(context);
  activeOwner = owner;
  return owner;
}
beforeEach(() => {
  if (activeOwner) throw new Error("Previous update-details fixture is still retiring.");
  setUiLocale("en");
  fixture.environmentId = "server-a";
});
afterEach(async () => {
  // Shared cleanup joins the same public-signal owner BEFORE restoring globals.
  await activeOwner?.cleanup();
  activeOwner = undefined;
  expect(fixture.listeners.size).toBe(0);
  setUiLocale(originalLocale);
});

const instanceId = ProviderInstanceId.make("codex-personal");
function provider(output = "private-command-output"): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Private account label",
    enabled: true,
    installed: true,
    version: "0.166.0",
    status: "ready",
    checkedAt: "2026-10-30T01:01:00.000Z",
    auth: { status: "authenticated" },
    models: [],
    slashCommands: [],
    skills: [],
    updateState: {
      status: "failed",
      startedAt: "2026-10-30T01:00:00.000Z",
      finishedAt: "2026-10-30T01:01:00.000Z",
      message: "Update command exited with code 1.",
      output,
      diagnostics: {
        phase: "command",
        category: "command_failed",
        exitCode: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        outputTruncated: false,
      },
    },
  };
}
const panel = (value: ServerProvider) => (
  <ProviderUpdateFailureDetails instanceId={instanceId} driver="codex" provider={value} />
);
const show = () => page.getByRole("button", { name: "Show failure details", exact: true });
const hide = () => page.getByRole("button", { name: "Hide failure details", exact: true });

it("reveals only on native input and keeps HTML/control-looking output literal without executable elements or copy actions", async (context) => {
  const owner = own(context);
  const raw =
    '日本語 💜❤️🩵🤍🩷💛💚 <img data-provider-output-sentinel src="invalid" onerror="throw Error(1)">\u001b[31m\u202e';
  const view = await owner.mount(panel(provider(raw)));
  expect(view.container.querySelector("pre")).toBeNull();
  expect(view.container.textContent).not.toContain("data-provider-output-sentinel");
  await owner.run(() => show().click());
  await owner.run(() => expect.element(hide()).toBeVisible());
  const output = view.container.querySelector("pre");
  expect(output?.textContent).toContain("日本語 💜❤️🩵🤍🩷💛💚 <img data-provider-output-sentinel");
  expect(output?.textContent).toContain("\\u{1B}[31m\\u{202E}");
  expect(output?.getAttribute("translate")).toBe("no");
  expect(view.container.querySelector("img,script,a")).toBeNull();
  await owner.run(() =>
    expect.element(page.getByRole("button", { name: /copy/i })).not.toBeInTheDocument(),
  );
  await owner.run(() => hide().click());
  expect(view.container.querySelector("pre")).toBeNull();
});

it("retains an explicit reveal across identical polling but collapses changed output even when the source state object was mutated", async (context) => {
  const owner = own(context);
  const current = provider();
  const view = await owner.mount(panel(current));
  await owner.run(() => show().click());
  await owner.run(() =>
    view.rerender(
      panel({
        ...current,
        updateState: {
          ...current.updateState!,
          diagnostics: { ...current.updateState!.diagnostics! },
        },
      }),
    ),
  );
  await owner.run(() => expect.element(hide()).toBeVisible());
  const mutable = current.updateState as { output: string | null };
  mutable.output = "new-private-output";
  await owner.run(() => view.rerender(panel({ ...current })));
  await owner.run(() => expect.element(show()).toBeVisible());
  expect(view.container.querySelector("pre")).toBeNull();
  expect(view.container.textContent).not.toContain("new-private-output");
  await owner.run(() => show().click());
  expect(view.container.querySelector("pre")?.textContent).toBe("new-private-output");
});

it("collapses a changed attempt and changed diagnostic metadata before showing new details", async (context) => {
  const owner = own(context);
  const current = provider();
  const view = await owner.mount(panel(current));
  await owner.run(() => show().click());
  const next = {
    ...current,
    updateState: { ...current.updateState!, startedAt: "2026-10-30T01:02:00.000Z" },
  };
  await owner.run(() => view.rerender(panel(next)));
  await owner.run(() => expect.element(show()).toBeVisible());
  expect(view.container.querySelector("pre")).toBeNull();
  await owner.run(() => show().click());
  const changed = {
    ...next,
    updateState: {
      ...next.updateState,
      diagnostics: { ...next.updateState.diagnostics!, outputTruncated: true },
    },
  };
  await owner.run(() => view.rerender(panel(changed)));
  await owner.run(() => expect.element(show()).toBeVisible());
  expect(view.container.querySelector("pre")).toBeNull();
});

it("does not carry a reveal across an environment switch with identical instance and attempt values", async (context) => {
  const owner = own(context);
  const view = await owner.mount(panel(provider()));
  await owner.run(() => show().click());
  fixture.environmentId = "server-b";
  for (const listener of fixture.listeners) listener();
  await owner.run(() => view.rerender(panel(provider())));
  await owner.run(() => expect.element(show()).toBeVisible());
  expect(view.container.querySelector("pre")).toBeNull();
  await owner.run(() => show().click());
  await owner.run(() => expect.element(hide()).toBeVisible());
});

it("never borrows another instance or driver's failure and hides an ownerless diagnostic panel", async (context) => {
  const owner = own(context);
  const view = await owner.mount(
    panel({ ...provider(), instanceId: ProviderInstanceId.make("codex-work") }),
  );
  expect(view.container.textContent).toBe("");
  await owner.run(() =>
    view.rerender(panel({ ...provider(), driver: ProviderDriverKind.make("claudeAgent") })),
  );
  expect(view.container.textContent).toBe("");
  fixture.environmentId = null;
  for (const listener of fixture.listeners) listener();
  await owner.run(() => view.rerender(panel(provider())));
  expect(view.container.textContent).toBe("");
});

it("keeps legacy output explicit, resets after failure clears, and reports timeout output unavailable rather than native silence", async (context) => {
  const owner = own(context);
  const current = provider("legacy-output");
  const legacy: ServerProviderUpdateState = {
    status: "failed",
    startedAt: null,
    finishedAt: null,
    message: current.updateState!.message,
    output: "legacy-output",
  };
  const view = await owner.mount(panel({ ...current, updateState: legacy }));
  await owner.run(() => show().click());
  expect(view.container.querySelector("pre")?.textContent).toBe("legacy-output");
  expect(view.container.textContent).toContain(
    "Detailed status was not recorded by this Cafe Code version.",
  );
  await owner.run(() =>
    view.rerender(panel({ ...current, updateState: { ...legacy, status: "running" } })),
  );
  expect(view.container.querySelector("pre")).toBeNull();
  await owner.run(() => view.rerender(panel({ ...current, updateState: legacy })));
  await owner.run(() => expect.element(show()).toBeVisible());
  expect(view.container.querySelector("pre")).toBeNull();
  await owner.run(() =>
    view.rerender(
      panel({
        ...current,
        updateState: {
          ...current.updateState!,
          output: "discarded-partial-output-sentinel",
          diagnostics: {
            ...current.updateState!.diagnostics!,
            timedOut: true,
            category: "command_timed_out",
          },
        },
      }),
    ),
  );
  await owner.run(() => show().click());
  expect(view.container.querySelector("pre")).toBeNull();
  expect(view.container.textContent).not.toContain("discarded-partial-output-sentinel");
  expect(view.container.textContent).toContain(
    "Command output is unavailable because the update timed out.",
  );
  expect(view.container.textContent).not.toContain("command_timed_out");
  expect(view.container.textContent).toContain("Running the update command");
});
