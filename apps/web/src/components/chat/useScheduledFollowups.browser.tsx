import {
  EnvironmentId,
  ProviderInstanceId,
  ScheduledFollowupId,
  ThreadId,
  type EnvironmentApi,
  type ScheduledFollowupListResult,
  type ScheduledFollowupRecord,
} from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { useScheduledFollowups } from "./useScheduledFollowups";

const environmentId = EnvironmentId.make("shared-schedule-browser-environment");
const threadId = ThreadId.make("shared-schedule-browser-chat");
const now = "2026-10-05T09:00:00.000Z";

function record(overrides: Partial<ScheduledFollowupRecord> = {}): ScheduledFollowupRecord {
  return {
    id: ScheduledFollowupId.make("11111111-1111-4111-8111-111111111111"),
    threadId,
    revision: 1,
    state: "pending_confirmation",
    name: "Synthetic pending proposal",
    prompt: "Check the isolated build fixture.",
    recurrence: { kind: "interval", anchorAt: now, everyMinutes: 5, timeZone: "Asia/Tokyo" },
    modelSelection: null,
    notificationPolicy: "changes-and-errors",
    endAt: null,
    maxRuns: null,
    allowAutoFinish: false,
    authorizedInstanceId: ProviderInstanceId.make("shared-schedule-browser-account"),
    permissionCeiling: "approval-required",
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    runCount: 0,
    lastRun: null,
    ...overrides,
  };
}

function installApi(scope = environmentId) {
  const list = vi.fn<NonNullable<EnvironmentApi["scheduledFollowups"]>["list"]>(async () => ({
    schedules: [record()],
    backendOnline: true,
  }));
  __setEnvironmentApiOverrideForTests(scope, {
    scheduledFollowups: { list },
  } as unknown as EnvironmentApi);
  return list;
}

function deferred() {
  let resolve!: (value: ScheduledFollowupListResult) => void;
  const promise = new Promise<ScheduledFollowupListResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface RenderSnapshot {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly schedules: readonly ScheduledFollowupRecord[];
  readonly loading: boolean;
}

function Probe(props: {
  label: string;
  environmentId?: EnvironmentId;
  threadId?: ThreadId;
  enabled?: boolean;
  onRender?: (snapshot: RenderSnapshot) => void;
}) {
  const scopeEnvironment = props.environmentId ?? environmentId;
  const scopeThread = props.threadId ?? threadId;
  const result = useScheduledFollowups(scopeEnvironment, scopeThread, props.enabled);
  props.onRender?.({ environmentId: scopeEnvironment, threadId: scopeThread, ...result });
  return (
    <section aria-label={props.label}>
      <p data-testid={props.label}>
        {result.loading ? "Loading" : (result.error ?? "Ready")}
        {result.schedules.map((schedule) => ` | ${schedule.name}`).join("")}
      </p>
      <button type="button" onClick={result.refresh}>
        Refresh {props.label}
      </button>
    </section>
  );
}

describe("useScheduledFollowups consumers", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shares refresh state and one polling clock between mounted Tasks and timeline consumers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const list = installApi();
    const screen = await render(
      <>
        <Probe label="Tasks" />
        <Probe label="Timeline" />
      </>,
    );
    try {
      await expect
        .element(page.getByTestId("Tasks"))
        .toHaveTextContent("Ready | Synthetic pending proposal");
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Synthetic pending proposal");
      expect(list).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      const pending = deferred();
      list.mockReturnValueOnce(pending.promise);
      await page.getByRole("button", { name: "Refresh Tasks", exact: true }).click();
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Loading | Synthetic pending proposal");
      pending.resolve({ schedules: [record({ name: "Reviewed schedule" })], backendOnline: true });
      await expect
        .element(page.getByTestId("Tasks"))
        .toHaveTextContent("Ready | Reviewed schedule");
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Reviewed schedule");
      expect(list).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      await screen.rerender(<Probe label="Timeline" />);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await screen.unmount();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("changes chats synchronously without rendering old rows even when the component keeps its key", async () => {
    const list = installApi();
    const otherThread = ThreadId.make("shared-schedule-second-chat");
    const rendered: RenderSnapshot[] = [];
    const onRender = (snapshot: RenderSnapshot) => rendered.push(snapshot);
    const screen = await render(<Probe label="Timeline" onRender={onRender} />);
    try {
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Synthetic pending proposal");
      const oldRead = deferred();
      const newRead = deferred();
      list.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
      await page.getByRole("button", { name: "Refresh Timeline", exact: true }).click();
      await screen.rerender(<Probe label="Timeline" threadId={otherThread} onRender={onRender} />);
      await expect.element(page.getByTestId("Timeline")).toHaveTextContent("Loading");
      expect(
        rendered
          .filter((snapshot) => snapshot.threadId === otherThread)
          .every((snapshot) =>
            snapshot.schedules.every((schedule) => schedule.threadId === otherThread),
          ),
      ).toBe(true);
      newRead.resolve({
        schedules: [record({ threadId: otherThread, name: "Second chat proposal" })],
        backendOnline: true,
      });
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Second chat proposal");
      oldRead.resolve({
        schedules: [record({ name: "Retired chat late response" })],
        backendOnline: true,
      });
      await Promise.resolve();
      expect(
        rendered
          .filter((snapshot) => snapshot.threadId === otherThread)
          .every((snapshot) =>
            snapshot.schedules.every((schedule) => schedule.threadId === otherThread),
          ),
      ).toBe(true);
      expect(document.body.textContent).not.toContain("Retired chat late response");
    } finally {
      await screen.unmount();
    }
  });

  it("changes environments synchronously even when both backends have the same chat ID", async () => {
    installApi();
    const otherEnvironment = EnvironmentId.make("shared-schedule-second-environment");
    const otherList = installApi(otherEnvironment);
    const newRead = deferred();
    otherList.mockReturnValueOnce(newRead.promise);
    const rendered: RenderSnapshot[] = [];
    const onRender = (snapshot: RenderSnapshot) => rendered.push(snapshot);
    const screen = await render(<Probe label="Timeline" onRender={onRender} />);
    try {
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Synthetic pending proposal");
      await screen.rerender(
        <Probe label="Timeline" environmentId={otherEnvironment} onRender={onRender} />,
      );
      await expect.element(page.getByTestId("Timeline")).toHaveTextContent("Loading");
      expect(
        rendered
          .filter((snapshot) => snapshot.environmentId === otherEnvironment)
          .every((snapshot) => snapshot.schedules.length === 0),
      ).toBe(true);
      newRead.resolve({
        schedules: [record({ name: "Second backend proposal" })],
        backendOnline: true,
      });
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Second backend proposal");
    } finally {
      await screen.unmount();
    }
  });

  it("does not subscribe or retain rows when disabled and starts fresh when enabled again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const list = installApi();
    const screen = await render(<Probe label="Timeline" enabled={false} />);
    try {
      await expect.element(page.getByTestId("Timeline")).toHaveTextContent("Ready");
      await page.getByRole("button", { name: "Refresh Timeline", exact: true }).click();
      expect(list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await screen.rerender(<Probe label="Timeline" />);
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Synthetic pending proposal");
      expect(list).toHaveBeenCalledTimes(1);
      await screen.rerender(<Probe label="Timeline" enabled={false} />);
      await expect.element(page.getByTestId("Timeline")).toHaveTextContent("Ready");
      expect(vi.getTimerCount()).toBe(0);
      const newRead = deferred();
      list.mockReturnValueOnce(newRead.promise);
      await screen.rerender(<Probe label="Timeline" />);
      await expect.element(page.getByTestId("Timeline")).toHaveTextContent("Loading");
      newRead.resolve({
        schedules: [record({ name: "Freshly enabled read" })],
        backendOnline: true,
      });
      await expect
        .element(page.getByTestId("Timeline"))
        .toHaveTextContent("Ready | Freshly enabled read");
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });
});
