import { describe, expect, it } from "vitest";

import { formatPendingPrimaryActionLabel, primaryStopState } from "./ComposerPrimaryActions";

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting…' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting…");
  });

  it("returns 'Submitting…' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting…");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("primary Stop during provider opening or recovery", () => {
  const opening = {
    isRunning: false,
    isQueueEditing: false,
    recoveryStopAvailable: false,
    connectingStopAvailable: true,
    hasSendableContent: true,
    postSubmitInterruptGuardActive: false,
    isEnvironmentUnavailable: false,
    stopInFlight: false,
  };
  it("keeps explicit cancellation visible with unsent input", () => {
    expect(primaryStopState(opening)).toEqual({ visible: true, disabled: false, showSend: false });
    expect(
      primaryStopState({ ...opening, connectingStopAvailable: false, recoveryStopAvailable: true }),
    ).toEqual({ visible: true, disabled: false, showSend: true });
  });
  it("keeps Stop available without introducing Send while editing the queue", () => {
    expect(
      primaryStopState({
        ...opening,
        isQueueEditing: true,
        connectingStopAvailable: false,
        recoveryStopAvailable: true,
      }),
    ).toEqual({ visible: true, disabled: false, showSend: false });
  });
  it("blocks duplicate Stop and unavailable environments", () => {
    expect(primaryStopState({ ...opening, stopInFlight: true })).toEqual({
      visible: true,
      disabled: true,
      showSend: false,
    });
    expect(primaryStopState({ ...opening, isEnvironmentUnavailable: true })).toEqual({
      visible: true,
      disabled: true,
      showSend: false,
    });
  });
  it("keeps background Stop beside a draft without making the terminal root running", () => {
    const background = {
      ...opening,
      connectingStopAvailable: false,
      backgroundStopAvailable: true,
    };
    expect(primaryStopState(background)).toEqual({
      visible: true,
      disabled: false,
      showSend: true,
    });
    expect(primaryStopState({ ...background, hasSendableContent: false })).toEqual({
      visible: true,
      disabled: false,
      showSend: false,
    });
    expect(primaryStopState({ ...background, isQueueEditing: true })).toEqual({
      visible: true,
      disabled: false,
      showSend: false,
    });
    expect(primaryStopState({ ...background, stopInFlight: true }).disabled).toBe(true);
    expect(primaryStopState({ ...background, isEnvironmentUnavailable: true }).disabled).toBe(true);
  });
  it("preserves ordinary active-turn draft and send-guard behavior", () => {
    const running = { ...opening, isRunning: true, connectingStopAvailable: false };
    expect(primaryStopState(running).visible).toBe(false);
    expect(
      primaryStopState({
        ...running,
        hasSendableContent: false,
        postSubmitInterruptGuardActive: true,
      }).visible,
    ).toBe(false);
    expect(primaryStopState({ ...running, hasSendableContent: false }).visible).toBe(true);
  });
});
