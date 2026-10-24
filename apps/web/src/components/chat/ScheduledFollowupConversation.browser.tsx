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
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";
import * as Schema from "effect/Schema";

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

function failedRun(errorCode: string): ScheduledFollowupRun {
  return {
    id: ScheduledFollowupRunId.make("22222222-2222-4222-8222-222222222222"),
    scheduleId: proposal().id,
    revision: 7,
    dueAt: now,
    state: "failed",
    commandId: CommandId.make("inline-review-failed-command"),
    messageId: MessageId.make("inline-review-failed-message"),
    intentSequence: null,
    turnId: null,
    modelSelection: null,
    createdAt: now,
    startedAt: null,
    completedAt: now,
    result: null,
    summary: null,
    errorCode,
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

type OwnerReviewPhase =
  | "render"
  | "notice"
  | "details"
  | "account"
  | "review"
  | "dialog"
  | "name"
  | "instructions"
  | "settings"
  | "paying-account"
  | "escape"
  | "editor-closed"
  | "reason"
  | "close"
  | "dialog-closed"
  | "review-pointerdown"
  | "review-pointerup"
  | "review-click"
  | "list-success"
  | "retirement";
const encodeOwnerReviewPhases = Schema.encodeSync(Schema.UnknownFromJsonString);
let ownerReviewLifetime: ReturnType<typeof createOwnerReviewLifetime> | undefined;
let ownerReviewFinalization: Promise<void> | undefined;

/** These two owner-review journeys retain their original native actions. Own
 * their pending work before the first await: afterEach runs before the public
 * onTestFinished hook, and must not reset the API or remove an in-flight target.
 */
function createOwnerReviewLifetime(context: TestContext) {
  const started = performance.now();
  let retired = false;
  let observationsRetired = false;
  let omitted = 0;
  let listSuccesses = 0;
  const pending = new Set<Promise<unknown>>();
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  let completion: Promise<void> | undefined;
  const removeListeners: (() => void)[] = [];
  const phases: {
    phase: OwnerReviewPhase;
    state: "entered" | "settled" | "observed";
    elapsedMs: number;
    ordinal: number;
    trusted?: boolean;
    targetExact?: boolean;
    preventedAtCapture?: boolean;
  }[] = [];
  const mark = (
    phase: OwnerReviewPhase,
    state: "entered" | "settled" | "observed",
    ordinal = 0,
    native?: { trusted: boolean; targetExact: boolean; preventedAtCapture: boolean },
  ) => {
    if (observationsRetired) return;
    try {
      if (phases.length === 16) {
        phases.shift();
        omitted = Math.min(1_000_000, omitted + 1);
      }
      const elapsed = performance.now() - started;
      phases.push({
        phase,
        state,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(60_000, Math.round(elapsed)))
          : 0,
        ordinal: Math.max(0, Math.min(1_000_000, ordinal)),
        ...(native ?? {}),
      });
    } catch {
      /* Passive diagnostics must not replace an original operation's result. */
    }
  };
  const retire = () => {
    retired = true;
  };
  const assertActive = () => {
    if (retired || context.signal.aborted) throw new Error("Synthetic owner review retired");
  };
  const track = <T,>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => {
        pending.delete(operation);
      },
      () => {
        pending.delete(operation);
      },
    );
    return operation;
  };
  const own = <T,>(phase: OwnerReviewPhase, start: () => Promise<T>): Promise<T> => {
    assertActive();
    mark(phase, "entered");
    const original = start();
    return track(
      original.then((value) => {
        assertActive();
        mark(phase, "settled");
        return value;
      }),
    );
  };
  const drain = async () => {
    // An already-admitted native click can finish its original React callback
    // and list read while retiring. Join those exact receipts as well; fixture
    // continuations cannot admit another action after the synchronous fence.
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const cleanup = (): Promise<void> => {
    if (completion) return completion;
    // Store the shared completion before retirement can wake another hook.
    // Neither cleanup nor the test body itself belongs to the pending set.
    completion = Promise.resolve().then(async () => {
      try {
        await drain();
        await mounted?.unmount();
        await drain();
        mark("retirement", "settled");
      } finally {
        for (const remove of removeListeners.splice(0)) remove();
        context.signal.removeEventListener("abort", retire);
        observationsRetired = true;
      }
    });
    retire();
    mark("retirement", "entered");
    return completion;
  };
  context.onTestFinished(cleanup);
  context.onTestFailed(() => {
    try {
      // Chromium's pinned tester forwards console errors to its diagnostic
      // channel; Node's stderr is not available in the browser document.
      console.error(
        `Synthetic owner-review phases: ${encodeOwnerReviewPhases({ phases, omitted })}\n`,
      );
    } catch {
      /* Keep the original failure; diagnostics contain no payload or error text. */
    }
  });
  context.signal.addEventListener("abort", retire, { once: true });
  if (context.signal.aborted) retire();
  const lifetime = {
    assertActive,
    own,
    cleanup,
    mount(element: Parameters<typeof render>[0]) {
      return own("render", () => {
        const original = render(element);
        track(
          original.then(
            (screen) => {
              mounted = screen;
            },
            () => undefined,
          ),
        );
        return original;
      });
    },
    observeList<T>(original: Promise<T>): Promise<T> {
      // Observe actual fulfillment, not invocation. Return the exact original
      // promise/result/rejection to the component; this is not review authority.
      track(
        original.then(
          () => {
            listSuccesses = Math.min(1_000_000, listSuccesses + 1);
            mark("list-success", "observed", listSuccesses);
          },
          () => undefined,
        ),
      );
      return original;
    },
    observeReviewButton(button: Element) {
      assertActive();
      for (const [type, phase] of [
        ["pointerdown", "review-pointerdown"],
        ["pointerup", "review-pointerup"],
        ["click", "review-click"],
      ] as const) {
        const observe = (event: Event) =>
          mark(phase, "observed", 0, {
            trusted: event.isTrusted,
            targetExact: event.target === button,
            preventedAtCapture: event.defaultPrevented,
          });
        button.addEventListener(type, observe, { capture: true, passive: true });
        removeListeners.push(() => button.removeEventListener(type, observe, { capture: true }));
      }
    },
  };
  ownerReviewLifetime = lifetime;
  return lifetime;
}

describe("inline scheduled follow-up owner review", () => {
  beforeEach(() => {
    if (ownerReviewLifetime) throw new Error("Previous synthetic owner review is still retiring");
  });
  afterEach(async () => {
    const lifetime = ownerReviewLifetime;
    const restore = () => {
      __resetEnvironmentApiOverridesForTests();
      vi.restoreAllMocks();
      document.body.innerHTML = "";
    };
    if (!lifetime) {
      restore();
      return;
    }
    // A hook which outlives its budget cannot let a second hook reset globals
    // early. Rejection retains the exact owner/completion, rather than retrying.
    ownerReviewFinalization ??= Promise.resolve().then(async () => {
      await lifetime.cleanup();
      restore();
    });
    const completion = ownerReviewFinalization;
    await completion;
    if (ownerReviewLifetime === lifetime && ownerReviewFinalization === completion) {
      ownerReviewLifetime = undefined;
      ownerReviewFinalization = undefined;
    }
  });

  it.for(["provider-unavailable", "private_fixture_token"])(
    "opens owner review after a sanitized %s explanation without enabling",
    async (errorCode, testContext) => {
      const lifetime = createOwnerReviewLifetime(testContext);
      lifetime.assertActive();
      const saved = proposal({ state: "needs_attention", lastRun: failedRun(errorCode) });
      const { api } = installApi([saved]);
      const list = api.list.getMockImplementation();
      if (!list) throw new Error("Synthetic owner review list implementation missing");
      api.list.mockImplementation(function (this: unknown, ...args) {
        return lifetime.observeList(Reflect.apply(list, this, args) as ReturnType<typeof list>);
      });
      let bodyFailed = false;
      try {
        await lifetime.mount(<ScheduledFollowupConversation context={context} />);
        const notice = page.getByRole("article", {
          name: `Scheduled follow-up notice: ${saved.name}`,
        });
        const reason =
          errorCode === "provider-unavailable"
            ? "The saved provider account or selected model was unavailable. This run was not submitted."
            : "This run failed.";
        await lifetime.own("notice", () =>
          expect.element(notice.getByText(reason, { exact: true })).toBeVisible(),
        );
        await lifetime.own("details", () =>
          notice.getByRole("button", { name: "Details", exact: true }).click(),
        );
        await lifetime.own("account", () =>
          expect
            .element(notice.getByText("Account: Personal Codex", { exact: true }))
            .toBeVisible(),
        );
        expectNoMutation(api);
        const review = notice.getByRole("button", { name: `Review schedule: ${saved.name}` });
        try {
          lifetime.observeReviewButton(review.element());
        } catch {
          // Passive observation cannot narrow the original native auto-wait.
          // A missing exact-element receipt remains unknown, not a new failure.
        }
        await lifetime.own("review", () => review.click());
        const dialog = page.getByRole("dialog", {
          name: "Review scheduled follow-up",
          exact: true,
        });
        await lifetime.own("dialog", () => expect.element(dialog).toBeVisible());
        await lifetime.own("name", () =>
          expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue(saved.name),
        );
        await lifetime.own("instructions", () =>
          expect
            .element(page.getByLabelText("Instructions", { exact: true }))
            .toHaveValue(saved.prompt),
        );
        await lifetime.own("settings", () =>
          dialog.getByText("Model and run settings", { exact: true }).click(),
        );
        await lifetime.own("paying-account", () =>
          expect
            .element(
              dialog.getByText(
                "Account: Personal Codex. This account will execute and pay for these follow-ups.",
                { exact: false },
              ),
            )
            .toBeVisible(),
        );
        expect(document.body.textContent).not.toContain(errorCode);
        expectNoMutation(api);
        await lifetime.own("escape", () => userEvent.keyboard("{Escape}"));
        // Escape belongs to the open editor and cancels that draft. Closing
        // the containing review remains a separate, explicit dialog action.
        await lifetime.own("editor-closed", () =>
          expect
            .element(page.getByRole("form", { name: "Scheduled follow-up editor" }))
            .not.toBeInTheDocument(),
        );
        await lifetime.own("reason", () =>
          expect.element(dialog.getByText(reason, { exact: true })).toBeVisible(),
        );
        expectNoMutation(api);
        await lifetime.own("close", () =>
          dialog.getByRole("button", { name: "Close", exact: true }).click(),
        );
        await lifetime.own("dialog-closed", () => expect.element(dialog).not.toBeInTheDocument());
        expectNoMutation(api);
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        if (bodyFailed) {
          try {
            await lifetime.cleanup();
          } catch {
            // Keep the original failure. The shared afterEach still observes
            // the exact rejected cleanup and retains its sticky owner lease.
          }
        } else {
          await lifetime.cleanup();
        }
      }
    },
  );

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
      // The full selected label identifies the computer-local option. Derive
      // this independently from native Intl so a Tokyo-hosted browser retains
      // the same exact-label assertion as a UTC-hosted CI browser.
      const selectedZone = saved.recurrence.timeZone;
      const localZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
      const zoneLabel =
        selectedZone === localZone ? `${selectedZone} (computer local time)` : selectedZone;
      await expect
        .element(page.getByLabelText("Timezone", { exact: true }))
        .toHaveTextContent(zoneLabel);
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
          .element(
            notice.getByText(`One-time follow-up · Planned: ${computerLocalTime(at)}`, {
              exact: true,
            }),
          )
          .toBeVisible();
        await expect
          .element(notice.getByText(`Next: ${computerLocalTime(nextRunAt)}`, { exact: true }))
          .toBeVisible();
        await notice.getByRole("button", { name: "Details", exact: true }).click();
        await expect
          .element(
            notice.getByText(`Schedule timezone: ${timeZone}`, {
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
