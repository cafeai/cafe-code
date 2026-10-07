import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledFollowupId,
  ThreadId,
  type EnvironmentApi,
  type ScheduledFollowupRecord,
  type ServerProvider,
} from "@cafecode/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { ScheduledFollowupConversation } from "./ScheduledFollowupConversation";
import { ScheduledFollowups, type ScheduledFollowupsContext } from "./ScheduledFollowups";

const environmentId = EnvironmentId.make("inline-schedule-environment");
const threadId = ThreadId.make("inline-schedule-chat");
const instanceId = ProviderInstanceId.make("inline-schedule-account");
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
  models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null }],
};
const context: ScheduledFollowupsContext = {
  environmentId,
  threadId,
  provider,
  modelSelection: { instanceId, model: "gpt-6-astra" },
  unavailable: false,
};

function proposal(overrides: Partial<ScheduledFollowupRecord> = {}): ScheduledFollowupRecord {
  return {
    id: ScheduledFollowupId.make("11111111-1111-4111-8111-111111111111"),
    threadId,
    revision: 7,
    state: "pending_confirmation",
    name: "Watch the synthetic build",
    prompt: "Check only the synthetic build and report meaningful changes.",
    recurrence: { kind: "interval", anchorAt: now, everyMinutes: 17, timeZone: "Asia/Tokyo" },
    modelSelection: null,
    notificationPolicy: "changes-and-errors",
    endAt: null,
    maxRuns: 5,
    allowAutoFinish: false,
    authorizedInstanceId: instanceId,
    permissionCeiling: "approval-required",
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    runCount: 0,
    lastRun: null,
    ...overrides,
  };
}

/** All data and mutations stay inside this fixture. Reading or opening an
 * owner review must never escape through a provider or mutate saved state. */
function installApi(initial: readonly ScheduledFollowupRecord[], owner = environmentId) {
  let records = [...initial];
  const api = {
    list: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["list"]>(async (input) => ({
      schedules: records.filter(
        (record) => record.threadId === input.threadId && record.state !== "deleted",
      ),
      backendOnline: true,
    })),
    save: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["save"]>(async (input) => {
      const prior = records.find((record) => record.id === input.id);
      if (!prior || prior.revision !== input.expectedRevision || !input.expectedInstanceId)
        throw new Error("Stale fixture revision");
      const saved: ScheduledFollowupRecord = {
        ...prior,
        ...input,
        authorizedInstanceId: input.expectedInstanceId,
        revision: prior.revision + 1,
        state: "active",
        nextRunAt: "2099-10-04T09:17:00.000Z",
      };
      records = records.map((record) => (record.id === saved.id ? saved : record));
      return saved;
    }),
    setStatus: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["setStatus"]>(),
    runNow: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["runNow"]>(),
    history: vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["history"]>(async () => ({
      runs: [],
      nextCursor: null,
    })),
    notification: vi.fn(async () => ({ notify: true })),
  };
  __setEnvironmentApiOverrideForTests(owner, {
    scheduledFollowups: api,
  } as unknown as EnvironmentApi);
  return { api };
}

function expectNoMutation(api: ReturnType<typeof installApi>["api"]) {
  expect(api.save).not.toHaveBeenCalled();
  expect(api.setStatus).not.toHaveBeenCalled();
  expect(api.runNow).not.toHaveBeenCalled();
}

function deferredList() {
  type Result = Awaited<ReturnType<NonNullable<EnvironmentApi["scheduledFollowups"]>["list"]>>;
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Use the browser's computer zone independently of the saved schedule's
 * selected zone and of the production presentation helper. */
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

describe("inline scheduled follow-up owner review", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("loads proposals while Tasks is closed and enables only the exact saved definition after explicit approval", async () => {
    const saved = proposal();
    const { api } = installApi([saved]);
    const screen = await render(<ScheduledFollowupConversation context={context} />);
    try {
      await expect
        .element(page.getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` }))
        .toBeVisible();
      await expect
        .element(page.getByText("Won’t run until you approve.", { exact: true }))
        .toBeVisible();
      expect(document.querySelector("[data-scheduled-followups]")).toBeNull();
      expect(api.list).toHaveBeenCalledWith({ threadId });
      expectNoMutation(api);

      await page
        .getByRole("button", { name: `Review schedule: ${saved.name}`, exact: true })
        .click();
      await expect
        .element(page.getByRole("dialog", { name: "Review scheduled follow-up", exact: true }))
        .toBeVisible();
      await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue(saved.name);
      await expect
        .element(page.getByLabelText("Instructions", { exact: true }))
        .toHaveValue(saved.prompt);
      await expect.element(page.getByLabelText("Every (minutes)", { exact: true })).toHaveValue(17);
      await expect
        .element(page.getByLabelText("Timezone", { exact: true }))
        .toHaveValue("Asia/Tokyo");
      expectNoMutation(api);

      await page.getByRole("button", { name: "Approve & enable", exact: true }).click();
      await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: saved.id,
          threadId,
          expectedInstanceId: instanceId,
          expectedRevision: saved.revision,
          name: saved.name,
          prompt: saved.prompt,
          recurrence: saved.recurrence,
          modelSelection: null,
          maxRuns: 5,
          notificationPolicy: saved.notificationPolicy,
        }),
      );
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await expect
        .element(
          page
            .getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` })
            .getByText("Scheduled", { exact: true }),
        )
        .toBeVisible();
      await expect
        .element(page.getByText("Won’t run until you approve.", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["Asia/Tokyo", "America/New_York"])(
    "shows planned and next-run notice dates in computer local time for a %s schedule",
    async (timeZone) => {
      const at = "2099-10-04T00:30:00.000Z";
      const nextRunAt = "2099-10-04T13:30:00.000Z";
      const saved = proposal({
        state: "active",
        recurrence: { kind: "once", at, timeZone },
        nextRunAt,
      });
      const { api } = installApi([saved]);
      const screen = await render(<ScheduledFollowupConversation context={context} />);
      try {
        const notice = page.getByRole("article", {
          name: `Scheduled follow-up notice: ${saved.name}`,
        });
        await expect
          .element(notice.getByText(`Planned: ${computerLocalTime(at)}`, { exact: true }))
          .toBeVisible();
        await expect
          .element(notice.getByText(`Next: ${computerLocalTime(nextRunAt)}`, { exact: true }))
          .toBeVisible();
        await expect
          .element(
            notice.getByText(`One-time follow-up · Schedule timezone: ${timeZone}`, {
              exact: true,
            }),
          )
          .toBeVisible();
        expect(document.querySelector("[data-scheduled-followups]")).toBeNull();
        expectNoMutation(api);
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(["account", "chat", "environment"] as const)(
    "discards the open review and unsaved values when the %s changes",
    async (change) => {
      const saved = proposal();
      const { api } = installApi([saved]);
      const nextInstanceId = ProviderInstanceId.make("different-paying-account");
      const nextContext: ScheduledFollowupsContext =
        change === "account"
          ? {
              ...context,
              provider: { ...provider, instanceId: nextInstanceId, displayName: "Work Codex" },
              modelSelection: { ...context.modelSelection, instanceId: nextInstanceId },
            }
          : change === "chat"
            ? { ...context, threadId: ThreadId.make("different-chat") }
            : {
                ...context,
                environmentId: EnvironmentId.make("different-environment"),
              };
      const other = change === "environment" ? installApi([], nextContext.environmentId) : null;
      const screen = await render(<ScheduledFollowupConversation context={context} />);
      try {
        await page
          .getByRole("button", { name: `Review schedule: ${saved.name}`, exact: true })
          .click();
        await page
          .getByLabelText("Instructions", { exact: true })
          .fill("Unsaved instructions from the previous owner");
        await screen.rerender(<ScheduledFollowupConversation context={nextContext} />);
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
        await expect
          .element(page.getByRole("form", { name: "Scheduled follow-up editor" }))
          .not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(
          "Unsaved instructions from the previous owner",
        );
        expectNoMutation(api);
        if (other) expectNoMutation(other.api);

        if (change === "account") {
          await expect
            .element(page.getByText("Account changed; review before enabling", { exact: false }))
            .toBeVisible();
          await page
            .getByRole("button", { name: `Review schedule: ${saved.name}`, exact: true })
            .click();
          await expect
            .element(page.getByLabelText("Instructions", { exact: true }))
            .toHaveValue(saved.prompt);
          await page.getByRole("button", { name: "Approve & enable", exact: true }).click();
          await vi.waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
          expect(api.save.mock.calls[0]?.[0].expectedInstanceId).toBe(nextInstanceId);
        } else {
          await expect
            .element(
              page.getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` }),
            )
            .not.toBeInTheDocument();
        }
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(["missing", "deleted"] as const)(
    "does not offer an editor when the review target is %s in the authoritative list",
    async (state) => {
      const saved = proposal();
      const { api } = installApi([saved]);
      const refreshed = deferredList();
      const screen = await render(<ScheduledFollowupConversation context={context} />);
      try {
        await expect
          .element(page.getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` }))
          .toBeVisible();
        api.list.mockImplementationOnce(() => refreshed.promise);
        await page
          .getByRole("button", { name: `Review schedule: ${saved.name}`, exact: true })
          .click();
        await expect
          .element(page.getByRole("dialog").getByText("Loading schedules…", { exact: true }))
          .toBeVisible();
        await expect
          .element(
            page.getByRole("dialog").getByRole("button", { name: "New follow-up", exact: true }),
          )
          .toBeDisabled();
        await expect
          .element(page.getByRole("form", { name: "Scheduled follow-up editor" }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: "Approve & enable", exact: true }))
          .not.toBeInTheDocument();
        expectNoMutation(api);
        refreshed.resolve({
          schedules: state === "missing" ? [] : [{ ...saved, state: "deleted" }],
          backendOnline: true,
        });
        await expect
          .element(
            page.getByText("This schedule is no longer available. No changes were made.", {
              exact: true,
            }),
          )
          .toBeVisible();
        await expect
          .element(page.getByRole("form", { name: "Scheduled follow-up editor" }))
          .not.toBeInTheDocument();
        await expect
          .element(page.getByRole("button", { name: "Approve & enable", exact: true }))
          .not.toBeInTheDocument();
        expectNoMutation(api);
      } finally {
        refreshed.resolve({ schedules: [], backendOnline: true });
        await screen.unmount();
      }
    },
  );

  it("keeps a failed review refresh non-actionable until the owner retries successfully", async () => {
    const saved = proposal();
    const { api } = installApi([saved]);
    const screen = await render(<ScheduledFollowupConversation context={context} />);
    try {
      await expect
        .element(page.getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` }))
        .toBeVisible();
      api.list.mockRejectedValueOnce(new Error("Private backend failure details"));
      await page
        .getByRole("button", { name: `Review schedule: ${saved.name}`, exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Review scheduled follow-up", exact: true });
      await expect
        .element(
          dialog.getByText("Schedules could not be refreshed. Reconnect or try again.", {
            exact: false,
          }),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("form", { name: "Scheduled follow-up editor" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Approve & enable", exact: true }))
        .not.toBeInTheDocument();
      // A cached Tasks card remains useful context, but it cannot provide a
      // second route around the failed fresh read that admitted this dialog.
      await expect
        .element(dialog.getByRole("button", { name: "Review & enable", exact: true }))
        .toBeDisabled();
      expect(document.body.textContent).not.toContain("Private backend failure details");
      expectNoMutation(api);
      await dialog.getByRole("button", { name: "Refresh schedules", exact: true }).click();
      await expect
        .element(page.getByLabelText("Instructions", { exact: true }))
        .toHaveValue(saved.prompt);
      expectNoMutation(api);
    } finally {
      await screen.unmount();
    }
  });

  it("shares the authoritative refresh when an approval is saved through the separate Tasks surface", async () => {
    const saved = proposal();
    const { api } = installApi([saved]);
    const screen = await render(
      <>
        <ScheduledFollowupConversation context={context} />
        <ScheduledFollowups context={context} />
      </>,
    );
    try {
      await expect
        .element(page.getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` }))
        .toBeVisible();
      await expect
        .element(
          page.getByRole("article", { name: `Scheduled follow-up: ${saved.name}`, exact: true }),
        )
        .toBeVisible();
      expect(api.list).toHaveBeenCalledTimes(1);
      await page.getByRole("button", { name: "Review & enable", exact: true }).click();
      expectNoMutation(api);
      await page.getByRole("button", { name: "Approve & enable", exact: true }).click();
      await expect
        .element(
          page
            .getByRole("article", { name: `Scheduled follow-up notice: ${saved.name}` })
            .getByText("Scheduled", { exact: true }),
        )
        .toBeVisible();
      await expect
        .element(page.getByText("Won’t run until you approve.", { exact: true }))
        .not.toBeInTheDocument();
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(api.setStatus).not.toHaveBeenCalled();
      expect(api.runNow).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
