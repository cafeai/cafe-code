import "../../index.css";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { EventId, type OrchestrationThreadActivity } from "@cafecode/contracts";
import { ComposerAsyncQuestionsPanel } from "./ComposerAsyncQuestionsPanel";
import {
  ASYNC_QUESTION_HANDLED_STORAGE_KEY,
  deriveAsyncQuestions,
  rememberHandledAsyncQuestion,
  withAsyncQuestionLock,
  type AsyncQuestion,
} from "./asyncQuestions";

const activities: OrchestrationThreadActivity[] = [
  {
    id: EventId.make(`codex-async-questions:${"a".repeat(64)}`),
    createdAt: "2026-09-10T00:00:00.000Z",
    tone: "info",
    kind: "provider.async-questions",
    summary: "Codex has questions",
    payload: {
      itemId: "item-1",
      questions: [{ title: "Which route?", options: ["Suggested route", "Another route"] }],
    },
    turnId: null,
  },
];
const multipleActivities: OrchestrationThreadActivity[] = [
  {
    ...activities[0]!,
    payload: {
      itemId: "item-1",
      questions: [
        { title: "Which route?", options: ["Suggested route", "Another route"] },
        { title: "What should happen next?", options: [] },
      ],
    },
  },
];

describe("inline async questions", () => {
  beforeEach(() => localStorage.removeItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY));

  it("waits for server acknowledgement before hiding skips and reads them in a fresh client", async () => {
    const onResolve = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onAnswer = vi.fn(async () => true);
    const screen = await render(
      <ComposerAsyncQuestionsPanel
        environmentId="local"
        threadId="thread"
        activities={activities}
        deliveryDisabled={false}
        onAnswer={onAnswer}
        onResolve={onResolve}
      />,
    );
    try {
      await page.getByText("1 question from Codex").click();
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Could not save the skipped questions. Try again.");
      expect(localStorage.getItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY)).toBeNull();
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      expect(onResolve.mock.calls[0]![0][0]).toMatchObject({
        activityId: activities[0]!.id,
        questionIndex: 0,
      });
      expect(onAnswer).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
    localStorage.removeItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY);
    const fresh = await render(
      <ComposerAsyncQuestionsPanel
        environmentId="remote-client"
        threadId="thread"
        activities={[
          {
            ...activities[0]!,
            payload: { ...(activities[0]!.payload as object), handledQuestionIndexes: [0] },
          },
        ]}
        deliveryDisabled={false}
        onAnswer={onAnswer}
        onResolve={onResolve}
      />,
    );
    try {
      await expect.element(fresh.container).toBeEmptyDOMElement();
      expect(onAnswer).not.toHaveBeenCalled();
    } finally {
      await fresh.unmount();
    }
  });

  it("publishes legacy browser receipts without sending an answer", async () => {
    const [question] = await deriveAsyncQuestions("local", "thread", activities);
    rememberHandledAsyncQuestion(localStorage, question!.id);
    const onAnswer = vi.fn(async () => true);
    const onResolve = vi.fn(async (_questions: readonly AsyncQuestion[]) => true);
    const screen = await render(
      <ComposerAsyncQuestionsPanel
        environmentId="local"
        threadId="thread"
        activities={activities}
        deliveryDisabled={false}
        onAnswer={onAnswer}
        onResolve={onResolve}
      />,
    );
    try {
      await vi.waitFor(() => expect(onResolve).toHaveBeenCalledOnce());
      expect(onResolve.mock.calls[0]![0][0]).toMatchObject({
        activityId: activities[0]!.id,
        questionIndex: 0,
      });
      expect(onAnswer).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("retries a failed state save without resending an accepted answer", async () => {
    const onAnswer = vi.fn(async () => true);
    const onResolve = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const screen = await render(
      <ComposerAsyncQuestionsPanel
        environmentId="local"
        threadId="thread"
        activities={activities}
        deliveryDisabled={false}
        onAnswer={onAnswer}
        onResolve={onResolve}
      />,
    );
    try {
      await page.getByText("1 question from Codex").click();
      await page.getByRole("button", { name: "Suggested route" }).click();
      await page.getByRole("button", { name: "Send answer" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(
          "Your answer was accepted, but its question state could not be saved. Try again.",
        );
      await page.getByRole("button", { name: "Send answer" }).click();
      await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      expect(onAnswer).toHaveBeenCalledOnce();
      expect(onResolve).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("retains rejected answers, requires explicit send, and preserves the independent main draft", async () => {
    const onAnswer = vi
      .fn<(_: string, id: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const screen = await render(
      <>
        <ComposerAsyncQuestionsPanel
          onResolve={async () => true}
          environmentId="local"
          threadId="thread"
          activities={activities}
          deliveryDisabled={false}
          onAnswer={onAnswer}
        />
        <textarea aria-label="Main draft" defaultValue="Main draft and its cursor stay here" />
        <input aria-label="Main file attachment" type="file" />
      </>,
    );
    try {
      await page.getByText("1 question from Codex").click();
      await page.getByRole("button", { name: "Suggested route" }).click();
      expect(onAnswer).not.toHaveBeenCalled();
      await page.getByLabelText("Your answer").fill("/do-not-run-as-a-command");
      await page.getByRole("button", { name: "Send answer" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toMatchTextContent("The answer was not queued.");
      await expect
        .element(page.getByLabelText("Your answer"))
        .toHaveValue("/do-not-run-as-a-command");
      expect(localStorage.getItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY)).toBeNull();
      await page.getByRole("button", { name: "Send answer" }).click();
      await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      expect(onAnswer).toHaveBeenCalledTimes(2);
      expect(onAnswer.mock.calls[0]).toEqual(onAnswer.mock.calls[1]);
      expect(onAnswer.mock.calls[0]![0]).toBe("> Which route?\n\n/do-not-run-as-a-command");
      await expect
        .element(page.getByLabelText("Main draft"))
        .toHaveValue("Main draft and its cursor stay here");
      await expect.element(page.getByLabelText("Main file attachment")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it.each([1, 2])(
    "serializes double clicks and skips against an in-flight answer with %i questions",
    async (count) => {
      let accept!: (result: boolean) => void;
      const onAnswer = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            accept = resolve;
          }),
      );
      const screen = await render(
        <ComposerAsyncQuestionsPanel
          onResolve={async () => true}
          environmentId="local"
          threadId="thread"
          activities={count === 1 ? activities : multipleActivities}
          deliveryDisabled={false}
          onAnswer={onAnswer}
        />,
      );
      try {
        await page
          .getByText(`${count} ${count === 1 ? "question" : "questions"} from Codex`)
          .click();
        await page.getByLabelText("Your answer").fill("Explicit answer");
        const submit = page.getByRole("button", { name: "Send answer" }).element();
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await expect.poll(() => onAnswer.mock.calls.length).toBe(1);
        await expect
          .element(page.getByRole("button", { name: "Skip", exact: true }))
          .toBeDisabled();
        if (count > 1)
          await expect
            .element(page.getByRole("button", { name: "Skip all", exact: true }))
            .toBeDisabled();
        accept(true);
        if (count === 1)
          await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
        else {
          await expect.element(page.getByText("1 question from Codex")).toBeInTheDocument();
          await expect
            .element(page.getByRole("button", { name: "Skip all", exact: true }))
            .not.toBeInTheDocument();
        }
        expect(onAnswer).toHaveBeenCalledTimes(1);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("skips all pending questions without sending or clearing the main draft and keeps new questions", async () => {
    const onAnswer = vi.fn(async () => true);
    const component = (rows = multipleActivities, environmentId = "local", key = "initial") => (
      <>
        <ComposerAsyncQuestionsPanel
          onResolve={async () => true}
          key={key}
          environmentId={environmentId}
          threadId="thread"
          activities={rows}
          deliveryDisabled={false}
          onAnswer={onAnswer}
        />
        <textarea aria-label="Main draft" defaultValue="Keep this main draft" />
      </>
    );
    const screen = await render(component());
    try {
      await page.getByText("2 questions from Codex").click();
      await page.getByLabelText("Your answer").fill("Discard this skipped answer");
      await page.getByRole("button", { name: "Skip all", exact: true }).click();
      await expect.element(page.getByText("2 questions from Codex")).not.toBeInTheDocument();
      await expect.element(page.getByLabelText("Main draft")).toHaveValue("Keep this main draft");
      expect(onAnswer).not.toHaveBeenCalled();

      // Reopening/replaying the same activities must keep both questions skipped.
      await screen.rerender(component([...multipleActivities], "local", "reload"));
      await expect.element(page.getByText("2 questions from Codex")).not.toBeInTheDocument();
      const newQuestion = {
        ...activities[0]!,
        id: EventId.make(`codex-async-questions:${"b".repeat(64)}`),
      };
      await screen.rerender(component([...multipleActivities, newQuestion], "local", "reload"));
      await page.getByText("1 question from Codex").click();
      await expect.element(page.getByLabelText("Your answer")).toHaveValue("");
      await expect
        .element(page.getByRole("button", { name: "Skip all", exact: true }))
        .not.toBeInTheDocument();

      // The same provider activity in a different environment is independent.
      await screen.rerender(component(multipleActivities, "remote"));
      await page.getByText("2 questions from Codex").click();
      await expect.element(page.getByLabelText("Your answer")).toHaveValue("");
      expect(onAnswer).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps questions that arrive while Skip all waits for another view's handling lock", async () => {
    const onAnswer = vi.fn(async () => true);
    const component = (rows: OrchestrationThreadActivity[]) => (
      <ComposerAsyncQuestionsPanel
        onResolve={async () => true}
        environmentId="local"
        threadId="thread"
        activities={rows}
        deliveryDisabled={false}
        onAnswer={onAnswer}
      />
    );
    const screen = await render(component(multipleActivities));
    let markAcquired!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = withAsyncQuestionLock(async () => {
      markAcquired();
      await released;
    });
    try {
      await acquired;
      await page.getByText("2 questions from Codex").click();
      await page.getByRole("button", { name: "Skip all", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Skip all", exact: true }))
        .toBeDisabled();
      const newQuestion = {
        ...activities[0]!,
        id: EventId.make(`codex-async-questions:${"b".repeat(64)}`),
      };
      await screen.rerender(component([...multipleActivities, newQuestion]));
      await expect.element(page.getByText("3 questions from Codex")).toBeInTheDocument();
      release();
      await lock;
      await expect.element(page.getByText("1 question from Codex")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Skip", exact: true })).toBeEnabled();
      await expect
        .element(page.getByRole("button", { name: "Skip all", exact: true }))
        .not.toBeInTheDocument();
      expect(onAnswer).not.toHaveBeenCalled();
    } finally {
      release();
      await lock;
      await screen.unmount();
    }
  });

  it("keeps skipped replay closed and isolates same-named remote threads", async () => {
    const onAnswer = vi.fn(async () => true);
    const component = (environmentId: string, key = "initial") => (
      <ComposerAsyncQuestionsPanel
        onResolve={async () => true}
        key={key}
        environmentId={environmentId}
        threadId="thread"
        activities={[...activities]}
        deliveryDisabled={false}
        onAnswer={onAnswer}
      />
    );
    const screen = await render(component("local"));
    try {
      await page.getByText("1 question from Codex").click();
      await page.getByLabelText("Your answer").fill("Local private draft");
      await page.getByRole("button", { name: "Skip" }).click();
      await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      await screen.rerender(component("local", "reload"));
      await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      await screen.rerender(component("remote"));
      await page.getByText("1 question from Codex").click();
      await expect.element(page.getByLabelText("Your answer")).toHaveValue("");
      expect(onAnswer).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps answer editing available while delivery is disabled", async () => {
    const screen = await render(
      <ComposerAsyncQuestionsPanel
        onResolve={async () => true}
        environmentId="local"
        threadId="thread"
        activities={activities}
        deliveryDisabled={true}
        onAnswer={async () => false}
      />,
    );
    try {
      await page.getByText("1 question from Codex").click();
      await page.getByLabelText("Your answer").fill("Draft while reconnecting");
      await expect.element(page.getByRole("button", { name: "Send answer" })).toBeDisabled();
      await expect.element(page.getByRole("button", { name: "Skip" })).toBeDisabled();
      await expect
        .element(page.getByLabelText("Your answer"))
        .toHaveValue("Draft while reconnecting");
    } finally {
      await screen.unmount();
    }
  });

  it.each(["storage event", "admission recheck"])(
    "preserves another view's handled question draft on %s",
    async (observation) => {
      const onAnswer = vi.fn(async () => true);
      const screen = await render(
        <ComposerAsyncQuestionsPanel
          onResolve={async () => true}
          environmentId="local"
          threadId="thread"
          activities={activities}
          deliveryDisabled={false}
          onAnswer={onAnswer}
        />,
      );
      try {
        await page.getByText("1 question from Codex").click();
        await page.getByLabelText("Your answer").fill("Keep this alternative answer");
        const [question] = await deriveAsyncQuestions("local", "thread", activities);
        rememberHandledAsyncQuestion(localStorage, question!.id);
        if (observation === "storage event") {
          window.dispatchEvent(
            new StorageEvent("storage", { key: ASYNC_QUESTION_HANDLED_STORAGE_KEY }),
          );
        } else {
          await page.getByRole("button", { name: "Send answer" }).click();
        }
        await expect
          .element(page.getByRole("status"))
          .toMatchTextContent("Handled in another view.");
        await expect
          .element(page.getByLabelText("Your answer"))
          .toHaveValue("Keep this alternative answer");
        await expect.element(page.getByRole("button", { name: "Send answer" })).toBeDisabled();
        expect(onAnswer).not.toHaveBeenCalled();
        await page.getByRole("button", { name: "Skip" }).click();
        await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    },
  );
});
