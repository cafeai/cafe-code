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
import { page, userEvent } from "vitest/browser";
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

/** Editor dropdowns are Select primitives: open by their field label, pick by name. */
async function chooseOption(label: string, option: string) {
  await page.getByLabelText(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function chooseTimeZone(zone: string) {
  const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  await chooseOption("Timezone", zone === localZone ? `${zone} (computer local time)` : zone);
}

/** Inspect the actual rendered choices, preserving the native-catalog assertions
 * while interacting with the same shared dropdown used by the editor. */
async function readTimeZoneChoices() {
  await page.getByLabelText("Timezone", { exact: true }).click();
  const listbox = page.getByRole("listbox");
  await expect.element(listbox).toBeVisible();
  const choices = Array.from(listbox.element().querySelectorAll('[role="option"]'), (option) =>
    option.textContent!.trim().replace(/ \(computer local time\)$/, ""),
  );
  await userEvent.keyboard("{Escape}");
  await expect.element(listbox).not.toBeInTheDocument();
  return choices;
}

async function fillRequired() {
  await page.getByLabelText("Name", { exact: true }).fill("Watch the build");
  await page
    .getByLabelText("Instructions", { exact: true })
    .fill("Check the build every five minutes; stop when it passes.");
}

/** Resolve expectations directly from the browser's clock zone. Importing the
 * production formatter here could allow a wrong selected-zone display policy
 * to satisfy both sides of the assertion. */
function computerLocalTime(instant: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(new Date(instant));
}

describe("scheduled follow-ups Tasks UI", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--primary");
  });

  it.each(["provider-unavailable", "private_fixture_token", "constructor"])(
    "shows a fixed failed-run reason in the card and history for %s without granting execution",
    async (errorCode) => {
      const run = makeRun(1, {
        state: "failed",
        intentSequence: null,
        startedAt: null,
        result: null,
        summary: null,
        errorCode,
      });
      const saved = makeSchedule(1, { state: "needs_attention", nextRunAt: null, lastRun: run });
      const api = installApi([saved]);
      api.history.mockResolvedValue({ runs: [run], nextCursor: null });
      const screen = await render(<ScheduledFollowups context={context} />);
      try {
        const card = page.getByRole("article", { name: `Scheduled follow-up: ${saved.name}` });
        const reason =
          errorCode === "provider-unavailable"
            ? "The saved provider account or selected model was unavailable. This run was not submitted."
            : "This run failed.";
        await expect.element(card.getByText(reason, { exact: true })).toBeVisible();
        await expect.element(card.getByText("Needs attention", { exact: true })).toBeVisible();
        if (errorCode === "provider-unavailable") {
          await expect
            .element(
              card.getByText(
                "Check the saved account and model in Settings, then review the schedule before enabling it again.",
                { exact: true },
              ),
            )
            .toBeVisible();
        } else {
          expect(card.element().textContent).not.toContain(errorCode);
          expect(card.element().textContent).not.toContain("not submitted");
        }
        await expect
          .element(card.getByRole("button", { name: "Run now", exact: true }))
          .not.toBeInTheDocument();
        await card.getByRole("button", { name: "Run history", exact: true }).click();
        const history = page.getByLabelText(`Run history for ${saved.name}`);
        await expect.element(history.getByText(reason, { exact: true })).toBeVisible();
        await expect.element(history.getByText("Failed", { exact: true })).toBeVisible();
        expect(history.element().textContent).not.toContain(errorCode);
        expect(api.runNow).not.toHaveBeenCalled();
        expect(api.save).not.toHaveBeenCalled();
        expect(api.setStatus).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("keeps a waiting occurrence distinct from a failed provider run", async () => {
    const run = makeRun(1, {
      state: "waiting",
      intentSequence: null,
      startedAt: null,
      completedAt: null,
      result: null,
      summary: null,
    });
    const saved = makeSchedule(1, { lastRun: run });
    const api = installApi([saved]);
    api.history.mockResolvedValue({ runs: [run], nextCursor: null });
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      const card = page.getByRole("article", { name: `Scheduled follow-up: ${saved.name}` });
      await expect.element(card.getByText("Waiting for this chat", { exact: true })).toBeVisible();
      await expect
        .element(card.getByRole("button", { name: "Run now", exact: true }))
        .toBeDisabled();
      await card.getByRole("button", { name: "Run history", exact: true }).click();
      const history = page.getByLabelText(`Run history for ${saved.name}`);
      await expect
        .element(history.getByText("Waiting for this chat", { exact: true }))
        .toBeVisible();
      expect(card.element().textContent).not.toContain("Failed");
      expect(card.element().textContent).not.toContain("unavailable");
      expect(api.runNow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["acceptance-unknown", "provider-unavailable", "private_fixture_token"])(
    "keeps an unconfirmed run fenced in the presentation even with the %s classification",
    async (errorCode) => {
      const run = makeRun(1, {
        state: "unknown",
        result: null,
        summary: null,
        errorCode,
      });
      const saved = makeSchedule(1, { state: "needs_attention", nextRunAt: null, lastRun: run });
      const api = installApi([saved]);
      api.history.mockResolvedValue({ runs: [run], nextCursor: null });
      const screen = await render(<ScheduledFollowups context={context} />);
      try {
        const card = page.getByRole("article", { name: `Scheduled follow-up: ${saved.name}` });
        await expect
          .element(
            card.getByText("Cafe could not confirm whether the provider accepted this run.", {
              exact: true,
            }),
          )
          .toBeVisible();
        await expect
          .element(
            card.getByText(
              "Wait for Cafe to reconcile this run. Check this chat for existing work; do not repeat an unconfirmed run.",
              { exact: true },
            ),
          )
          .toBeVisible();
        expect(card.element().textContent).not.toContain("not submitted");
        expect(card.element().textContent).not.toContain(errorCode);
        await card.getByRole("button", { name: "Run history", exact: true }).click();
        const history = page.getByLabelText(`Run history for ${saved.name}`);
        await expect
          .element(history.getByText("Status unconfirmed", { exact: true }))
          .toBeVisible();
        await expect
          .element(
            history.getByText("Cafe could not confirm whether the provider accepted this run.", {
              exact: true,
            }),
          )
          .toBeVisible();
        expect(api.runNow).not.toHaveBeenCalled();
        expect(api.save).not.toHaveBeenCalled();
        expect(api.setStatus).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

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

  it("opens review for a paused schedule under the current account instead of resuming its old account", async () => {
    const previousAccount = ProviderInstanceId.make("previous-schedule-account");
    const record = makeSchedule(1, {
      state: "paused",
      authorizedInstanceId: previousAccount,
      modelSelection: { instanceId: previousAccount, model: "gpt-6.1-sol" },
    });
    const api = installApi([record]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await expect
        .element(page.getByText("Account changed; review before enabling", { exact: false }))
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Resume", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect
        .element(page.getByRole("form", { name: "Scheduled follow-up editor" }))
        .toBeVisible();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
      await page.getByText("Model and run settings", { exact: true }).click();
      await expect
        .element(
          page.getByText(
            "Account: Personal Codex. This account will execute and pay for these follow-ups.",
            { exact: true },
          ),
        )
        .toBeVisible();
      expect(
        page.getByRole("form", { name: "Scheduled follow-up editor" }).element().textContent,
      ).not.toContain(previousAccount);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        id: record.id,
        expectedRevision: record.revision,
        expectedInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6.1-sol" },
      });
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
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
      await chooseOption("Repeat", "Weekdays");
      await page.getByLabelText("Time in selected timezone").fill("10:30");
      await chooseTimeZone("Asia/Tokyo");
      await expect.element(page.getByLabelText("Upcoming runs")).toBeVisible();
      await page.getByText("Model and run settings", { exact: true }).click();
      await chooseOption("Model settings", "Choose settings for follow-ups");
      await chooseOption("Model", "GPT-6.1 Sol");
      await chooseOption("Reasoning effort", "Medium");
      await page.getByLabelText("Fast mode", { exact: true }).click();
      await chooseOption("Notifications", "Errors only");
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
        expectedInstanceId: instanceId,
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
      await chooseOption("Repeat", "Custom calendar");
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

  it("rejects malformed intervals and offers only supported timezone choices", async () => {
    const api = installApi();
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await page.getByLabelText("Every (minutes)").fill("1");
      await expect.element(page.getByRole("button", { name: "Create follow-up" })).toBeDisabled();
      await page.getByLabelText("Every (minutes)").fill("5");
      await expect.element(page.getByRole("button", { name: "Create follow-up" })).toBeEnabled();
      const choices = await readTimeZoneChoices();
      expect(choices).not.toContain("invalid-zone");
      expect(api.save).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("defaults to the computer timezone and includes the standard IANA catalog", async () => {
    const api = installApi();
    const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      const timezone = page.getByLabelText("Timezone", { exact: true });
      await expect.element(timezone).toHaveTextContent(`${localZone} (computer local time)`);
      const choices = await readTimeZoneChoices();
      expect(choices).toEqual(
        expect.arrayContaining(["UTC", "America/New_York", "Asia/Tokyo", localZone]),
      );
      expect(choices).toEqual(expect.arrayContaining(Intl.supportedValuesOf("timeZone")));
      expect(new Set(choices).size).toBe(choices.length);
      expect(api.save).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("retains a supported saved timezone alias in the dropdown and reviewed save", async () => {
    const saved = makeSchedule(1, {
      recurrence: { kind: "interval", anchorAt: now, everyMinutes: 5, timeZone: "US/Eastern" },
    });
    const api = installApi([saved]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect
        .element(page.getByLabelText("Timezone", { exact: true }))
        .toHaveTextContent("US/Eastern");
      await page.getByLabelText("Name", { exact: true }).fill("Keep the saved timezone alias");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({ recurrence: saved.recurrence });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an invalid saved timezone non-actionable without a permissive fallback", async () => {
    const api = installApi([
      makeSchedule(1, {
        recurrence: {
          kind: "once",
          at: "2099-10-04T09:30:00.000Z",
          timeZone: "invalid-zone",
        },
      }),
    ]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await expect
        .element(
          page
            .getByLabelText("Upcoming runs")
            .getByText(
              "Check the time, timezone, and recurrence fields. Intervals must be at least 5 minutes.",
              { exact: true },
            ),
        )
        .toBeVisible();
      await page.getByLabelText("Name", { exact: true }).fill("Still invalid saved timezone");
      await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["clear", "replace"] as const)(
    "requires explicit review before the owner can %s a saved end date outside the native input range",
    async (resolution) => {
      const originalEndAt = "9999-12-31T23:30:00.000Z";
      const saved = makeSchedule(1, {
        recurrence: { kind: "once", at: "2099-10-04T00:30:00.000Z", timeZone: "Asia/Tokyo" },
        endAt: originalEndAt,
      });
      const api = installApi([saved]);
      const screen = await render(<ScheduledFollowups context={context} />);
      try {
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await page
          .getByLabelText("Instructions", { exact: true })
          .fill("Only edit the instructions.");
        await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
        await expect
          .element(
            page
              .getByLabelText("Upcoming runs")
              .getByText(
                "Review the saved end date in Model and run settings: enter a new date or explicitly clear it.",
                { exact: true },
              ),
          )
          .toBeVisible();

        // The native control cannot express Tokyo's year 10000. Neither its
        // blank value nor a direct form submission authorizes removing the
        // saved execution limit, even after another draft field was edited.
        const form = page.getByRole("form", { name: "Scheduled follow-up editor" }).element();
        (form as HTMLFormElement).requestSubmit();
        await expect.element(page.getByRole("alert")).toBeVisible();
        expect(api.save).not.toHaveBeenCalled();
        expect(api.setStatus).not.toHaveBeenCalled();
        expect(api.runNow).not.toHaveBeenCalled();

        await page.getByText("Model and run settings", { exact: true }).click();
        await expect.element(page.getByLabelText("End at", { exact: true })).toHaveValue("");
        await expect
          .element(
            page.getByText(
              `The saved end limit cannot be shown in its scheduling timezone. Saved limit: ${computerLocalTime(originalEndAt)}`,
              { exact: true },
            ),
          )
          .toBeVisible();
        const clear = page.getByRole("button", { name: "Clear saved end date", exact: true });
        await expect.element(clear).toBeVisible();
        if (resolution === "clear") {
          await clear.click();
        } else {
          await page.getByLabelText("End at", { exact: true }).fill("2099-10-04T10:30");
        }
        await expect.element(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
        await expect.element(clear).not.toBeInTheDocument();
        await page.getByRole("button", { name: "Save changes" }).click();
        await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
        expect(api.save.mock.calls[0]?.[0]).toMatchObject({
          id: saved.id,
          expectedRevision: saved.revision,
          recurrence: saved.recurrence,
          endAt: resolution === "clear" ? null : "2099-10-04T01:30:00.000Z",
        });
        expect(api.setStatus).not.toHaveBeenCalled();
        expect(api.runNow).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("does not remove a saved end limit merely because an invalid saved timezone is repaired", async () => {
    const originalEndAt = "2099-10-04T09:30:00.000Z";
    const api = installApi([
      makeSchedule(1, {
        recurrence: { kind: "interval", anchorAt: now, everyMinutes: 5, timeZone: "invalid-zone" },
        endAt: originalEndAt,
      }),
    ]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await chooseTimeZone("Asia/Tokyo");
      await page.getByLabelText("Instructions", { exact: true }).fill("Repair the saved timezone.");
      await expect.element(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await expect
        .element(
          page
            .getByLabelText("Upcoming runs")
            .getByText(
              "Review the saved end date in Model and run settings: enter a new date or explicitly clear it.",
              { exact: true },
            ),
        )
        .toBeVisible();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
      await page.getByText("Model and run settings", { exact: true }).click();
      await expect.element(page.getByLabelText("End at", { exact: true })).toHaveValue("");
      await expect
        .element(
          page.getByText(
            `The saved end limit cannot be shown in its scheduling timezone. Saved limit: ${computerLocalTime(originalEndAt)}`,
            { exact: true },
          ),
        )
        .toBeVisible();
      await page.getByLabelText("End at", { exact: true }).fill("2099-10-04T10:30");
      await expect.element(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        recurrence: { kind: "interval", timeZone: "Asia/Tokyo" },
        endAt: "2099-10-04T01:30:00.000Z",
      });
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    {
      timeZone: "Asia/Tokyo",
      at: "2099-10-04T09:30:27.123Z",
      endAt: "2099-10-04T10:30:57.456Z",
      atInput: "2099-10-04T18:30",
      endInput: "2099-10-04T19:30",
    },
    {
      // Both saved instants are in the second 01:xx hour of New York's
      // November fold. Re-parsing the minute text would select the earlier
      // occurrence and lose both the reviewed instant and its precision.
      timeZone: "America/New_York",
      at: "2099-11-01T06:30:27.123Z",
      endAt: "2099-11-01T06:45:57.456Z",
      atInput: "2099-11-01T01:30",
      endInput: "2099-11-01T01:45",
    },
  ])(
    "preserves precise saved $timeZone one-shot and end instants when editing only instructions",
    async ({ timeZone, at, endAt, atInput, endInput }) => {
      const api = installApi([
        makeSchedule(1, { recurrence: { kind: "once", at, timeZone }, endAt }),
      ]);
      const screen = await render(<ScheduledFollowups context={context} />);
      try {
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        await expect.element(page.getByLabelText("Run at", { exact: true })).toHaveValue(atInput);
        await page.getByText("Model and run settings", { exact: true }).click();
        await expect.element(page.getByLabelText("End at", { exact: true })).toHaveValue(endInput);
        await page
          .getByLabelText("Instructions", { exact: true })
          .fill("Only update the instructions.");
        await page.getByRole("button", { name: "Save changes" }).click();
        await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
        expect(api.save.mock.calls[0]?.[0]).toMatchObject({ recurrence: { at }, endAt });
      } finally {
        await screen.unmount();
      }
    },
  );

  it("requires explicit proposal review before enabling an agent-created schedule", async () => {
    const api = installApi([makeSchedule(1, { state: "pending_confirmation" })]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await expect.element(page.getByText("Needs your approval", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Proposed by an agent — review before enabling.", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Account: Personal Codex", { exact: true }))
        .toBeVisible();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("button", { name: "Run now", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Review & enable" }).click();
      await expect
        .element(page.getByLabelText("Instructions", { exact: true }))
        .toHaveValue("Check the synthetic build. Report changes only.");
      await page.getByText("Model and run settings", { exact: true }).click();
      await expect
        .element(
          page.getByText(
            "Account: Personal Codex. This account will execute and pay for these follow-ups.",
            { exact: false },
          ),
        )
        .toBeVisible();
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Approve & enable" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0].expectedRevision).toBe(3);
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        expectedInstanceId: instanceId,
        modelSelection: null,
      });
      expect(api.setStatus).not.toHaveBeenCalled();
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
          expectedInstanceId: instanceId,
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
        expectedInstanceId: instanceId,
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
          expectedInstanceId: instanceId,
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

  it("uses explicitly selected UTC once-only instants and disconnect-safe controls", async () => {
    const api = installApi();
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await chooseOption("Repeat", "Once");
      await chooseTimeZone("UTC");
      await page.getByLabelText("Run at", { exact: true }).fill("2099-10-04T09:30");
      await page.getByRole("button", { name: "Create follow-up" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0].recurrence).toMatchObject({
        kind: "once",
        at: "2099-10-04T09:30:00.000Z",
        timeZone: "UTC",
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

  it.each([
    ["Asia/Tokyo", "2099-10-04T00:30:00.000Z", "2099-10-04T01:30:00.000Z"],
    ["America/New_York", "2099-10-04T13:30:00.000Z", "2099-10-04T14:30:00.000Z"],
  ])("converts one-shot and end wall times in %s into exact instants", async (zone, at, endAt) => {
    const api = installApi();
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await chooseOption("Repeat", "Once");
      await chooseTimeZone(zone);
      await page.getByLabelText("Run at", { exact: true }).fill("2099-10-04T09:30");
      await expect
        .element(
          page.getByText(`Time in ${zone}. The preview below uses your local time.`, {
            exact: true,
          }),
        )
        .toBeVisible();
      await expect
        .element(
          page.getByLabelText("Upcoming runs").getByText(computerLocalTime(at), { exact: true }),
        )
        .toBeVisible();
      await page.getByText("Model and run settings", { exact: true }).click();
      await page.getByLabelText("End at", { exact: true }).fill("2099-10-04T10:30");
      await page.getByRole("button", { name: "Create follow-up" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        recurrence: { kind: "once", timeZone: zone, at },
        endAt,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("treats an explicit timezone change as new intent while retaining the entered wall times", async () => {
    const api = installApi([
      makeSchedule(1, {
        recurrence: { kind: "once", at: "2099-10-04T09:30:00.000Z", timeZone: "UTC" },
        endAt: "2099-10-04T10:30:00.000Z",
      }),
    ]);
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await chooseTimeZone("Asia/Tokyo");
      await expect
        .element(page.getByLabelText("Run at", { exact: true }))
        .toHaveValue("2099-10-04T09:30");
      await page.getByText("Model and run settings", { exact: true }).click();
      await expect
        .element(page.getByLabelText("End at", { exact: true }))
        .toHaveValue("2099-10-04T10:30");
      await page.getByRole("button", { name: "Save changes" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0]).toMatchObject({
        recurrence: { kind: "once", at: "2099-10-04T00:30:00.000Z", timeZone: "Asia/Tokyo" },
        endAt: "2099-10-04T01:30:00.000Z",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows previews in computer local time with a zone label independently of the selected timezone", async () => {
    const api = installApi();
    const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const selectedZone = localZone === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
    const instant =
      selectedZone === "Asia/Tokyo" ? "2099-10-04T00:30:00.000Z" : "2099-10-04T13:30:00.000Z";
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      await page.getByRole("button", { name: "New follow-up" }).click();
      await fillRequired();
      await chooseOption("Repeat", "Once");
      await chooseTimeZone(selectedZone);
      await page.getByLabelText("Run at", { exact: true }).fill("2099-10-04T09:30");
      const preview = page.getByLabelText("Upcoming runs");
      await expect
        .element(preview.getByText(`Next runs · local time · ${localZone}`, { exact: true }))
        .toBeVisible();
      await expect
        .element(preview.getByText(computerLocalTime(instant), { exact: true }))
        .toBeVisible();
      expect(api.save).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows saved next-run and history timestamps in computer local time with an explicit zone", async () => {
    const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const saved = makeSchedule(1, {
      recurrence: {
        kind: "once",
        at: "2099-10-04T00:30:00.000Z",
        timeZone: localZone === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo",
      },
      nextRunAt: "2099-10-04T00:30:00.000Z",
    });
    const api = installApi([saved]);
    api.history.mockResolvedValue({ runs: [makeRun()], nextCursor: null });
    const screen = await render(<ScheduledFollowups context={context} />);
    try {
      const card = page.getByRole("article", { name: `Scheduled follow-up: ${saved.name}` });
      await expect
        .element(card.getByText(`Next: ${computerLocalTime(saved.nextRunAt!)}`, { exact: true }))
        .toBeVisible();
      await card.getByRole("button", { name: "Run history" }).click();
      await expect.element(page.getByText("Run 1 summary", { exact: true })).toBeVisible();
      const history = page.getByLabelText(`Run history for ${saved.name}`).element();
      expect(history.querySelector("time")?.textContent).toBe(computerLocalTime(now));
      expect(history.querySelector("time")?.getAttribute("datetime")).toBe(now);
      expect(api.save).not.toHaveBeenCalled();
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
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
      await chooseOption("Model settings", "Choose settings for follow-ups");
      await page.getByRole("button", { name: "Create follow-up" }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save.mock.calls[0]?.[0].modelSelection).toEqual({ instanceId: account, model });
      expect(api.save.mock.calls[0]?.[0].expectedInstanceId).toBe(account);
      expect(api.save.mock.calls[0]?.[0]).not.toHaveProperty("runtimeMode");
    } finally {
      await screen.unmount();
    }
  });
});
