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
import { ScheduledFollowupNotices } from "./ScheduledFollowupNotices";
import type { ScheduledFollowupsContext } from "./ScheduledFollowups";

const environmentId = EnvironmentId.make("inline-schedule-fixture-environment");
const threadId = ThreadId.make("inline-schedule-fixture-chat");
const instanceId = ProviderInstanceId.make("inline-schedule-fixture-account");
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
  models: [],
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
    id: ScheduledFollowupId.make(`33333333-3333-4333-8333-${String(index).padStart(12, "0")}`),
    threadId,
    revision: 2,
    state: "active",
    name: `Build follow-up ${index}`,
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

/** No provider or scheduler is contacted by these presentational fixtures. Any
 * accidental read or mutation would fail and be visible in the assertions. */
function installUnusedApi() {
  const api = {
    list: vi.fn(() => Promise.reject(new Error("Unexpected schedule read"))),
    save: vi.fn(() => Promise.reject(new Error("Unexpected schedule mutation"))),
    setStatus: vi.fn(() => Promise.reject(new Error("Unexpected schedule mutation"))),
    runNow: vi.fn(() => Promise.reject(new Error("Unexpected schedule execution"))),
    history: vi.fn(() => Promise.reject(new Error("Unexpected schedule history read"))),
    notification: vi.fn(() => Promise.reject(new Error("Unexpected schedule notification"))),
  };
  __setEnvironmentApiOverrideForTests(environmentId, {
    scheduledFollowups: api,
  } as unknown as EnvironmentApi);
  return api;
}

function visibleScheduleNames() {
  return Array.from(document.querySelectorAll("article h4"), (heading) => heading.textContent);
}

describe("inline scheduled follow-up notices", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("font-size");
    document.documentElement.classList.remove("dark");
  });

  it("shows saved proposals without Tasks and opens owner review with the keyboard without scheduling", async () => {
    const api = installUnusedApi();
    const record = makeSchedule(1, { state: "pending_confirmation", nextRunAt: null });
    const onReview = vi.fn();
    const screen = await render(
      <ScheduledFollowupNotices context={context} schedules={[record]} onReview={onReview} />,
    );
    try {
      await expect.element(page.getByText("Needs your approval", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Won’t run until you approve.", { exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Every 5 minutes · Schedule timezone: Asia/Tokyo", { exact: true }))
        .toBeVisible();
      await expect.element(page.getByText("Account: Personal Codex")).toBeVisible();
      await expect
        .element(page.getByText("Uses chat settings · gpt-6-astra · Effort: ultra"))
        .toBeVisible();
      expect(onReview).not.toHaveBeenCalled();
      const review = page.getByRole("button", { name: `Review schedule: ${record.name}` });
      review.element().focus();
      await expect.element(review).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(onReview).toHaveBeenCalledExactlyOnceWith(record);
      for (const operation of Object.values(api)) expect(operation).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Run now");
      expect(document.body.textContent).not.toContain("Enable schedule");
    } finally {
      await screen.unmount();
    }
  });

  it("follows authoritative lifecycle changes and removes deleted schedules", async () => {
    const record = makeSchedule(1, { state: "pending_confirmation" });
    const onReview = vi.fn();
    const screen = await render(
      <ScheduledFollowupNotices context={context} schedules={[record]} onReview={onReview} />,
    );
    try {
      for (const [state, label] of [
        ["active", "Scheduled"],
        ["paused", "Paused"],
        ["needs_attention", "Needs attention"],
        ["completed", "Finished"],
      ] as const) {
        await screen.rerender(
          <ScheduledFollowupNotices
            context={context}
            schedules={[{ ...record, state }]}
            onReview={onReview}
          />,
        );
        await expect.element(page.getByText(label, { exact: true })).toBeVisible();
        expect(document.body.textContent).not.toContain("Won’t run until you approve");
        expect(document.body.textContent).not.toContain("awaiting approval");
        if (state === "active") expect(document.body.textContent).toContain("Next:");
        else expect(document.body.textContent).not.toContain("Next:");
      }
      await screen.rerender(
        <ScheduledFollowupNotices
          context={context}
          schedules={[{ ...record, state: "deleted" }]}
          onReview={onReview}
        />,
      );
      await expect
        .element(page.getByRole("region", { name: "Scheduled follow-up notices" }))
        .not.toBeInTheDocument();
      expect(onReview).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("prioritizes approvals, orders recent records, and makes every schedule reachable within three cards", async () => {
    const schedules = [
      ...Array.from({ length: 6 }, (_, index) =>
        makeSchedule(index + 1, {
          updatedAt: `2026-10-04T09:0${index}:00.000Z`,
        }),
      ),
      makeSchedule(7, { state: "pending_confirmation", updatedAt: "2026-10-01T09:00:00.000Z" }),
    ];
    const screen = await render(
      <ScheduledFollowupNotices context={context} schedules={schedules} onReview={vi.fn()} />,
    );
    try {
      expect(visibleScheduleNames()).toEqual([
        "Build follow-up 7",
        "Build follow-up 6",
        "Build follow-up 5",
      ]);
      await page.getByRole("button", { name: "More follow-ups" }).click();
      expect(visibleScheduleNames()).toEqual([
        "Build follow-up 4",
        "Build follow-up 3",
        "Build follow-up 2",
      ]);
      await page.getByRole("button", { name: "More follow-ups" }).click();
      expect(visibleScheduleNames()).toEqual(["Build follow-up 1"]);
      await expect.element(page.getByRole("button", { name: "More follow-ups" })).toBeDisabled();
      await page.getByRole("button", { name: "1 awaiting approval" }).click();
      expect(visibleScheduleNames()).toEqual([
        "Build follow-up 7",
        "Build follow-up 6",
        "Build follow-up 5",
      ]);
      await expect
        .element(page.getByRole("button", { name: "Previous", exact: true }))
        .toBeDisabled();
      // A replaced scope must never retain a previous chat's page index or rows.
      await page.getByRole("button", { name: "More follow-ups" }).click();
      const nextThread = ThreadId.make("inline-schedule-next-chat");
      await screen.rerender(
        <ScheduledFollowupNotices
          context={{ ...context, threadId: nextThread }}
          schedules={[
            ...schedules,
            makeSchedule(8, { threadId: nextThread, name: "Next chat follow-up" }),
          ]}
          onReview={vi.fn()}
        />,
      );
      expect(visibleScheduleNames()).toEqual(["Next chat follow-up"]);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the saved account and model override instead of attributing it to a changed chat account", async () => {
    const previousAccount = ProviderInstanceId.make("previous-fixture-account");
    const record = makeSchedule(1, {
      state: "paused",
      authorizedInstanceId: previousAccount,
      modelSelection: {
        instanceId: previousAccount,
        model: "gpt-6.1-sol",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: true },
        ],
      },
    });
    const screen = await render(
      <ScheduledFollowupNotices context={context} schedules={[record]} onReview={vi.fn()} />,
    );
    try {
      await expect.element(page.getByText("gpt-6.1-sol · Effort: medium · Fast: on")).toBeVisible();
      await expect
        .element(
          page.getByText(`Account: ${previousAccount} · Account changed; review before enabling`),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Personal Codex");
      expect(document.body.textContent).not.toContain("Uses chat settings");
    } finally {
      await screen.unmount();
    }
  });

  it("labels stale and disconnected snapshots without claiming execution stopped or exposing raw errors", async () => {
    const record = makeSchedule();
    const onReview = vi.fn();
    const onRefresh = vi.fn();
    const screen = await render(
      <ScheduledFollowupNotices
        context={context}
        schedules={[record]}
        error="sensitive transport fixture detail"
        onReview={onReview}
        onRefresh={onRefresh}
      />,
    );
    try {
      await expect.element(page.getByText("Last known: Scheduled", { exact: true })).toBeVisible();
      expect(document.body.textContent).toContain("Schedule status may be out of date.");
      expect(document.body.textContent).toContain("Last reported next run:");
      expect(document.body.textContent).not.toContain("sensitive transport fixture detail");
      await expect
        .element(page.getByRole("button", { name: `Review schedule: ${record.name}` }))
        .toBeDisabled();
      await page.getByRole("button", { name: "Refresh schedules" }).click();
      expect(onRefresh).toHaveBeenCalledOnce();
      await screen.rerender(
        <ScheduledFollowupNotices
          context={{ ...context, unavailable: true }}
          schedules={[record]}
          onReview={onReview}
          onRefresh={onRefresh}
        />,
      );
      expect(document.body.textContent).toContain("This backend is disconnected.");
      await expect.element(page.getByRole("button", { name: "Refresh schedules" })).toBeDisabled();
      await expect.element(page.getByText("Last known: Scheduled", { exact: true })).toBeVisible();
      expect(onReview).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps one-time dates explicit, escapes titles, and fits narrow scaled layouts in both themes", async () => {
    const title = '<img src="x" onerror="alert(1)"> [Approve](javascript:alert(1))';
    const record = makeSchedule(1, {
      name: title,
      state: "pending_confirmation",
      recurrence: { kind: "once", at: "2099-10-04T09:05:00.000Z", timeZone: "Asia/Tokyo" },
    });
    const host = document.createElement("div");
    host.style.width = "240px";
    document.body.append(host);
    document.documentElement.style.setProperty("font-size", "130%");
    document.documentElement.style.setProperty("--primary", "#dc2626");
    const screen = await render(
      <ScheduledFollowupNotices context={context} schedules={[record]} onReview={vi.fn()} />,
      { container: host },
    );
    try {
      await expect.element(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      expect(host.querySelectorAll("img, script, a")).toHaveLength(0);
      expect(host.textContent).toContain("One-time follow-up · Schedule timezone: Asia/Tokyo");
      expect(host.textContent).toContain("Planned:");
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle("dark", dark);
        const status = page.getByText("Needs your approval", { exact: true }).element();
        expect(getComputedStyle(status).color).toBe("rgb(220, 38, 38)");
        const card = page
          .getByRole("article", { name: `Scheduled follow-up notice: ${title}` })
          .element();
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an empty successful conversation quiet but exposes first-load and read failures", async () => {
    const onReview = vi.fn();
    const screen = await render(
      <ScheduledFollowupNotices context={context} schedules={[]} loading onReview={onReview} />,
    );
    try {
      await expect.element(page.getByText("Loading schedules…")).toBeVisible();
      await screen.rerender(
        <ScheduledFollowupNotices
          context={context}
          schedules={[]}
          error="unavailable"
          onReview={onReview}
        />,
      );
      expect(document.body.textContent).toContain("Schedules could not be refreshed.");
      await screen.rerender(
        <ScheduledFollowupNotices context={context} schedules={[]} onReview={onReview} />,
      );
      await expect
        .element(page.getByRole("region", { name: "Scheduled follow-up notices" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
