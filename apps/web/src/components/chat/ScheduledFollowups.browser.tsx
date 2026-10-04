import "../../index.css";

import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledFollowupId,
  ScheduledFollowupRunId,
  ThreadId,
  type EnvironmentApi,
  type ScheduledFollowupRecord,
  type ScheduledFollowupRun,
  type ServerProvider,
} from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { ComposerTaskProgress } from "./ComposerTaskProgress";
import { ScheduledFollowups, type ScheduledFollowupsContext } from "./ScheduledFollowups";
import { SessionRail } from "./SessionRail";

const environmentId = EnvironmentId.make("schedule-browser-environment");
const threadId = ThreadId.make("schedule-browser-chat");
const instanceId = ProviderInstanceId.make("codex-private-fixture");
const now = "2026-10-04T09:00:00.000Z";
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Personal Codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  slashCommands: [],
  skills: [],
  models: [
    { slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null },
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            type: "select",
            label: "Reasoning effort",
            options: [
              { id: "medium", label: "Medium" },
              { id: "ultra", label: "Ultra" },
            ],
          },
          { id: "fastMode", type: "boolean", label: "Fast mode" },
        ],
      },
    },
  ],
};
const context: ScheduledFollowupsContext = {
  environmentId,
  threadId,
  provider,
  modelSelection: {
    instanceId,
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "ultra" }],
  },
  unavailable: false,
};

function makeSchedule(
  index = 1,
  overrides: Partial<ScheduledFollowupRecord> = {},
): ScheduledFollowupRecord {
  return {
    id: ScheduledFollowupId.make(`11111111-1111-4111-8111-${String(index).padStart(12, "0")}`),
    threadId,
    revision: 3,
    state: "active",
    name: `Build check ${index}`,
    prompt: "Check the synthetic build. Report changes only.",
    recurrence: { kind: "interval", anchorAt: now, everyMinutes: 5, timeZone: "Asia/Tokyo" },
    modelSelection: null,
    notificationPolicy: "changes-and-errors",
    endAt: null,
    maxRuns: null,
    allowAutoFinish: false,
    authorizedInstanceId: instanceId,
    permissionCeiling: "approval-required",
    createdAt: now,
    updatedAt: now,
    nextRunAt: "2099-10-04T09:05:00.000Z",
    runCount: 0,
    lastRun: null,
    ...overrides,
  };
}

function makeRun(index = 1, overrides: Partial<ScheduledFollowupRun> = {}): ScheduledFollowupRun {
  return {
    id: ScheduledFollowupRunId.make(`22222222-2222-4222-8222-${String(index).padStart(12, "0")}`),
    scheduleId: makeSchedule().id,
    revision: 3,
    dueAt: now,
    state: "completed",
    commandId: CommandId.make(`scheduled-command-${index}`),
    messageId: MessageId.make(`scheduled-message-${index}`),
    intentSequence: 1,
    turnId: null,
    modelSelection: null,
    createdAt: now,
    startedAt: now,
    completedAt: now,
    result: "no-change",
    summary: `Run ${index} summary`,
    errorCode: null,
    ...overrides,
  };
}

function installApi(initial: readonly ScheduledFollowupRecord[] = []) {
  let records = [...initial];
  const api = {
    list: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["list"]>(async () => ({
      schedules: records.filter((record) => record.state !== "deleted"),
      backendOnline: true as const,
    })),
    save: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["save"]>(async (input) => {
      const prior = records.find((entry) => entry.id === input.id);
      const saved = {
        ...makeSchedule(50),
        ...prior,
        ...input,
        revision: (prior?.revision ?? 0) + 1,
        state: "active" as const,
      };
      records = [...records.filter((entry) => entry.id !== saved.id), saved];
      return saved;
    }),
    setStatus: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["setStatus"]>(
      async (input) => {
        const prior = records.find((entry) => entry.id === input.id)!;
        const saved = { ...prior, state: input.state, revision: prior.revision + 1 };
        records = records.map((entry) => (entry.id === input.id ? saved : entry));
        return saved;
      },
    ),
    runNow: vi.fn(async () => makeRun(1, { state: "waiting", completedAt: null })),
    history: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["history"]>(async () => ({
      runs: [],
      nextCursor: null,
    })),
    notification: vi.fn(async () => ({ notify: true })),
  };
  __setEnvironmentApiOverrideForTests(environmentId, {
    scheduledFollowups: api,
  } as unknown as EnvironmentApi);
  return api;
}

async function fillRequired() {
  await page.getByLabelText("Name", { exact: true }).fill("Watch the build");
  await page
    .getByLabelText("Instructions", { exact: true })
    .fill("Check the build every five minutes; stop when it passes.");
}

describe("scheduled follow-ups Tasks UI", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--primary");
  });

  it("requires review before running a schedule after the chat account changes", async () => {
    const api = installApi([
      makeSchedule(1, { authorizedInstanceId: ProviderInstanceId.make("previous-account") }),
    ]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await expect
        .element(page.getByText("Account changed; review before enabling", { exact: false }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Run now", exact: true }))
        .toBeDisabled();
      await expect.element(page.getByRole("button", { name: "Edit", exact: true })).toBeEnabled();
      expect(api.runNow).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps schedules independent of an empty checklist and uses the existing theme", async () => {
    installApi([makeSchedule()]);
    document.documentElement.style.setProperty("--primary", "#dc2626");
    const host = document.createElement("div");
    host.style.cssText = "display:flex;flex-direction:column;width:280px;height:680px";
    document.body.append(host);
    const screen = await render(
      <SessionRail
        plan={null}
        usage={null}
        scheduledFollowups={context}
        onShowInComposer={vi.fn()}
      />,
      { container: host },
    );
    try {
      await expect.element(page.getByRole("heading", { name: "Build check 1" })).toBeVisible();
      expect(host.textContent).toContain("No tasks yet.");
      expect(host.textContent).toContain("Personal Codex");
      const card = page
        .getByRole("article", { name: "Scheduled follow-up: Build check 1" })
        .element();
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
      const next = Array.from(card.querySelectorAll("p")).find((element) =>
        element.textContent?.startsWith("Next:"),
      )!;
      expect(getComputedStyle(next).color).toBe("rgb(220, 38, 38)");
      expect(host.textContent).not.toContain("1 active");
    } finally {
      await screen.unmount();
    }
  });

  it("offers Tasks from the composer without active agents or a provider plan", async () => {
    const api = installApi();
    const screen = await render(<ComposerTaskProgress plan={null} scheduledFollowups={context} />);
    try {
      expect(api.list).not.toHaveBeenCalled();
      await page
        .getByRole("button", { name: "Tasks and scheduled follow-ups. Show task list" })
        .click();
      await expect.element(page.getByRole("button", { name: "New follow-up" })).toBeVisible();
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    } finally {
      await screen.unmount();
    }
  });

  it("creates a reviewed recurrence with same-account model options, notification policy, and run limits", async () => {
    const api = installApi();
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await page.getByLabelText("Repeat", { exact: true }).selectOptions("weekdays");
      await page.getByLabelText("Time in selected timezone").fill("10:30");
      await page.getByLabelText("Timezone", { exact: true }).fill("Asia/Tokyo");
      await expect.element(page.getByLabelText("Upcoming runs")).toBeVisible();
      await page.getByText("Model and run settings", { exact: true }).click();
      await page.getByLabelText("Model settings", { exact: true }).selectOptions("override");
      await page.getByLabelText("Model", { exact: true }).selectOptions("gpt-6.1-sol");
      await page.getByLabelText("Reasoning effort", { exact: true }).selectOptions("medium");
      await page.getByLabelText("Fast mode", { exact: true }).click();
      await page.getByLabelText("Notifications", { exact: true }).selectOptions("errors-only");
      await page.getByLabelText("Maximum runs", { exact: true }).fill("10");
      await page
        .getByLabelText(
          "Allow the agent to finish this schedule when the instructions are satisfied.",
        )
        .click();
      await page.getByRole("button", { name: "Create follow-up" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        name: "Watch the build",
        recurrence: {
          kind: "calendar",
          timeZone: "Asia/Tokyo",
          hour: 10,
          minute: 30,
          weekdays: [1, 2, 3, 4, 5],
        },
        modelSelection: {
          instanceId,
          model: "gpt-6.1-sol",
          options: [
            { id: "reasoningEffort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        },
        notificationPolicy: "errors-only",
        maxRuns: 10,
        allowAutoFinish: true,
      });
      expect(api.save.mock.calls[0]?.[0]).not.toHaveProperty("id");
      await expect.element(page.getByRole("heading", { name: "Watch the build" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("edits custom calendar constraints and preserves the reviewed revision", async () => {
    const record = makeSchedule();
    const api = installApi([record]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabelText("Repeat", { exact: true }).selectOptions("custom");
      await page.getByLabelText("Weekdays (0–6)").fill("1,3");
      await page.getByLabelText("Days of month (1–31)").fill("1,15");
      await page.getByLabelText("Months (1–12)").fill("1,6,12");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        id: record.id,
        expectedRevision: 3,
        recurrence: { kind: "calendar", weekdays: [1, 3], monthDays: [1, 15], months: [1, 6, 12] },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("rejects malformed schedules locally without a mutation or permissive fallback", async () => {
    const api = installApi();
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await page.getByLabelText("Every (minutes)").fill("1");
      await expect.element(page.getByRole("button", { name: "Create follow-up" })).toBeDisabled();
      await page.getByLabelText("Every (minutes)").fill("5");
      await page.getByLabelText("Timezone", { exact: true }).fill("invalid-zone");
      await expect.element(page.getByRole("button", { name: "Create follow-up" })).toBeDisabled();
      expect(api.save).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("preserves precise saved one-shot and end instants when editing only instructions", async () => {
    const at = "2099-10-04T09:30:27.123Z";
    const endAt = "2099-10-04T10:30:57.456Z";
    const api = installApi([
      makeSchedule(1, { recurrence: { kind: "once", at, timeZone: "Asia/Tokyo" }, endAt }),
    ]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page
        .getByLabelText("Instructions", { exact: true })
        .fill("Only update the instructions.");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({ recurrence: { at }, endAt });
    } finally {
      await screen.unmount();
    }
  });

  it("requires explicit proposal review before enabling an agent-created schedule", async () => {
    const api = installApi([makeSchedule(1, { state: "pending_confirmation" })]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await expect.element(page.getByText("Needs your approval", { exact: true })).toBeVisible();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Run now", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Review & enable" }).click();
      await expect
        .element(page.getByLabelText("Instructions", { exact: true }))
        .toHaveValue("Check the synthetic build. Report changes only.");
      await page.getByRole("button", { name: "Approve & enable" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0].expectedRevision).toBe(3);
    } finally {
      await screen.unmount();
    }
  });

  it("runs and pauses using the exact saved revision without interrupting a provider", async () => {
    const record = makeSchedule();
    const api = installApi([record]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Run now", exact: true }).click();
      await vi.waitFor(() =>
        expect(api.runNow).toHaveBeenCalledExactlyOnceWith({
          threadId,
          id: record.id,
          expectedRevision: 3,
        }),
      );
      await expect
        .element(
          page.getByText("Run requested. It will wait if this chat is busy.", { exact: true }),
        )
        .toBeVisible();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await vi.waitFor(() =>
        expect(api.setStatus).toHaveBeenCalledExactlyOnceWith({
          threadId,
          id: record.id,
          expectedRevision: 3,
          state: "paused",
        }),
      );
      await expect
        .element(
          page.getByText("Schedule paused. An already running turn is not interrupted.", {
            exact: true,
          }),
        )
        .toBeVisible();
      await page.getByRole("button", { name: "Resume", exact: true }).click();
      expect(api.setStatus.mock.calls[1]?.[0]).toMatchObject({
        expectedRevision: 4,
        state: "active",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("does not retry ambiguous writes and retains the editable draft", async () => {
    const api = installApi([makeSchedule()]);
    api.save.mockRejectedValue(new Error("transport lost"));
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabelText("Name", { exact: true }).fill("Changed draft");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect.element(page.getByRole("alert")).toBeVisible();
      expect(page.getByRole("alert").element().textContent).toContain(
        "no automatic retry was sent",
      );
      expect(api.save).toHaveBeenCalledTimes(1);
      await expect
        .element(page.getByLabelText("Name", { exact: true }))
        .toHaveValue("Changed draft");
    } finally {
      await screen.unmount();
    }
  });

  it("confirms deletion, supports cancellation, and refreshes the saved list without interrupting a run", async () => {
    const record = makeSchedule(1, {
      lastRun: makeRun(1, { state: "running", completedAt: null }),
    });
    const api = installApi([record]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await expect.element(page.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect
        .element(
          page.getByText(
            "Delete this schedule? Future runs will stop. An already running turn is not interrupted.",
            { exact: true },
          ),
        )
        .toBeVisible();
      expect(api.setStatus).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Keep schedule", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Delete schedule", exact: true }))
        .not.toBeInTheDocument();
      expect(api.setStatus).not.toHaveBeenCalled();

      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete schedule", exact: true }).click();
      await vi.waitFor(() =>
        expect(api.setStatus).toHaveBeenCalledExactlyOnceWith({
          threadId,
          id: record.id,
          expectedRevision: record.revision,
          state: "deleted",
        }),
      );
      await expect
        .element(page.getByRole("article", { name: "Scheduled follow-up: Build check 1" }))
        .not.toBeInTheDocument();
      await expect
        .element(
          page.getByText("Schedule a check-in or a repeating task for this chat.", { exact: true }),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Finished schedules (1)", exact: true }))
        .not.toBeInTheDocument();
      expect(api.list.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(api.runNow).not.toHaveBeenCalled();
      expect(api.save).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("hides ended schedules by default and paginates both schedules and run history", async () => {
    const records = Array.from({ length: 7 }, (_, index) => makeSchedule(index + 1));
    const api = installApi([
      ...records,
      makeSchedule(8, { state: "completed", name: "Old finished check" }),
    ]);
    api.history.mockImplementation(async (input) =>
      input.before
        ? { runs: [makeRun(20)], nextCursor: null }
        : {
            runs: Array.from({ length: 10 }, (_, index) => makeRun(index + 1)),
            nextCursor: "opaque-older-page",
          },
    );
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await expect.element(page.getByRole("heading", { name: "Build check 1" })).toBeVisible();
      expect(document.querySelectorAll("article")).toHaveLength(5);
      expect(document.body.textContent).not.toContain("Old finished check");
      expect(document.body.textContent).not.toContain("Build check 6");
      expect(api.history).not.toHaveBeenCalled();
      await page
        .getByRole("article", { name: "Scheduled follow-up: Build check 1" })
        .getByRole("button", { name: "Run history" })
        .click();
      await expect.element(page.getByText("Run 1 summary", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Older runs" }).click();
      await expect.element(page.getByText("Run 20 summary", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("Run 1 summary");
      expect(api.history.mock.calls[1]?.[0]).toMatchObject({
        before: "opaque-older-page",
        limit: 10,
      });
      await page.getByRole("button", { name: "Next schedules" }).click();
      expect(document.querySelectorAll("article")).toHaveLength(2);
      await page.getByRole("button", { name: "Finished schedules (1)" }).click();
      await expect.element(page.getByRole("heading", { name: "Old finished check" })).toBeVisible();
      expect(document.querySelectorAll("article")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("uses explicit once-only UTC instants and disconnect-safe controls", async () => {
    const api = installApi();
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await page.getByLabelText("Repeat", { exact: true }).selectOptions("once");
      await page.getByLabelText("Run at (UTC)").fill("2099-10-04T09:30");
      await page.getByRole("button", { name: "Create follow-up" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0].recurrence).toMatchObject({
        kind: "once",
        at: "2099-10-04T09:30:00.000Z",
      });
      await screen.rerender(<ScheduledFollowups context={{ ...context, unavailable: true }} />);
      await expect.element(page.getByRole("button", { name: "New follow-up" })).toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Run now", exact: true }))
        .toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("coalesces visible reads, pauses hidden polling, and retires the timer on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = installApi([makeSchedule()]);
    let release!: (value: { schedules: ScheduledFollowupRecord[]; backendOnline: true }) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const screen = await render(<ScheduledFollowups context={context} />);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(api.list).toHaveBeenCalledTimes(1);
    release({ schedules: [makeSchedule()], backendOnline: true });
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(api.list).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(3));
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it("never publishes a stale read from a previously selected chat", async () => {
    const api = installApi([
      makeSchedule(2, { name: "New chat follow-up", threadId: ThreadId.make("new-chat") }),
    ]);
    let release!: (value: { schedules: ScheduledFollowupRecord[]; backendOnline: true }) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const screen = await render(<ScheduledFollowups key="old-chat" context={context} />);
    try {
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
      await screen.rerender(
        <ScheduledFollowups
          key="new-chat"
          context={{ ...context, threadId: ThreadId.make("new-chat") }}
        />,
      );
      await expect.element(page.getByRole("heading", { name: "New chat follow-up" })).toBeVisible();
      release({
        schedules: [makeSchedule(1, { name: "Stale old follow-up" })],
        backendOnline: true,
      });
      await Promise.resolve();
      expect(document.body.textContent).not.toContain("Stale old follow-up");
      expect(api.list.mock.calls[1]?.[0]).toEqual({ threadId: ThreadId.make("new-chat") });
    } finally {
      await screen.unmount();
    }
  });

  it("reloads saved schedules when the Tasks view is recreated instead of owning their lifetime", async () => {
    const api = installApi();
    const first = await render(<ScheduledFollowups context={context} />);
    await page.getByRole("button", { name: "New follow-up" }).click();
    await fillRequired();
    await page.getByRole("button", { name: "Create follow-up" }).click();
    await expect.element(page.getByRole("heading", { name: "Watch the build" })).toBeVisible();
    await first.unmount();
    const readsBeforeReopen = api.list.mock.calls.length;
    const reopened = await render(<ScheduledFollowups context={context} />);
    try {
      await expect.element(page.getByRole("heading", { name: "Watch the build" })).toBeVisible();
      expect(api.list.mock.calls.length).toBeGreaterThan(readsBeforeReopen);
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(api.runNow).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
    } finally {
      await reopened.unmount();
    }
  });

  it.each([
    ["claudeAgent", "Claude", "claude-fable-5-1"],
    ["grok", "Grok", "grok-build"],
  ])("keeps %s scheduled settings provider-neutral", async (driver, label, model) => {
    const api = installApi();
    const account = ProviderInstanceId.make(`${driver}-account`);
    const providerContext: ScheduledFollowupsContext = {
      ...context,
      modelSelection: { instanceId: account, model },
      provider: {
        ...provider,
        instanceId: account,
        driver: ProviderDriverKind.make(driver),
        displayName: label,
        models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
      },
    };
    const screen = await render(<ScheduledFollowups context={providerContext} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await page.getByText("Model and run settings", { exact: true }).click();
      expect(document.body.textContent).toContain(`Account: ${label}`);
      await page.getByLabelText("Model settings", { exact: true }).selectOptions("override");
      await page.getByRole("button", { name: "Create follow-up" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0].modelSelection).toEqual({ instanceId: account, model });
      expect(api.save.mock.calls[0]?.[0]).not.toHaveProperty("runtimeMode");
    } finally {
      await screen.unmount();
    }
  });
});
