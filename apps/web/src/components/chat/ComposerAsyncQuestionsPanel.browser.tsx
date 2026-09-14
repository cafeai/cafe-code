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

describe("inline async questions", () => {
  beforeEach(() => localStorage.removeItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY));

  it("retains rejected answers, requires explicit send, and preserves the independent main draft", async () => {
    const onAnswer = vi
      .fn<(_: string, id: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const screen = await render(
      <>
        <ComposerAsyncQuestionsPanel
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
      await page.getByRole("button", { name: "Queue answer" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("The answer was not queued.");
      await expect
        .element(page.getByLabelText("Your answer"))
        .toHaveValue("/do-not-run-as-a-command");
      expect(localStorage.getItem(ASYNC_QUESTION_HANDLED_STORAGE_KEY)).toBeNull();
      await page.getByRole("button", { name: "Queue answer" }).click();
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

  it("serializes double clicks and skip against an in-flight durable acceptance", async () => {
    let accept!: (result: boolean) => void;
    const onAnswer = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const screen = await render(
      <ComposerAsyncQuestionsPanel
        environmentId="local"
        threadId="thread"
        activities={activities}
        deliveryDisabled={false}
        onAnswer={onAnswer}
      />,
    );
    try {
      await page.getByText("1 question from Codex").click();
      await page.getByLabelText("Your answer").fill("Explicit answer");
      const submit = page.getByRole("button", { name: "Queue answer" }).element();
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await expect.poll(() => onAnswer.mock.calls.length).toBe(1);
      await expect.element(page.getByRole("button", { name: "Skip" })).toBeDisabled();
      accept(true);
      await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      expect(onAnswer).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps skipped replay closed and isolates same-named remote threads", async () => {
    const onAnswer = vi.fn(async () => true);
    const component = (environmentId: string, key = "initial") => (
      <ComposerAsyncQuestionsPanel
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
      await expect.element(page.getByRole("button", { name: "Queue answer" })).toBeDisabled();
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
          await page.getByRole("button", { name: "Queue answer" }).click();
        }
        await expect
          .element(page.getByRole("status"))
          .toHaveTextContent("Handled in another view.");
        await expect
          .element(page.getByLabelText("Your answer"))
          .toHaveValue("Keep this alternative answer");
        await expect.element(page.getByRole("button", { name: "Queue answer" })).toBeDisabled();
        expect(onAnswer).not.toHaveBeenCalled();
        await page.getByRole("button", { name: "Skip" }).click();
        await expect.element(page.getByText("1 question from Codex")).not.toBeInTheDocument();
      } finally {
        await screen.unmount();
      }
    },
  );
});
