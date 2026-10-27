import { describe, expect, it } from "vitest";
import { TurnId } from "@cafecode/contracts";
import {
  getThreadNotificationKind,
  isThreadNotificationPending,
  type ThreadNotificationState,
} from "./threadNotification";

const idle: ThreadNotificationState = {
  running: false,
  turnId: null,
  userInputPending: false,
};
const running = { ...idle, running: true };
const question = { ...running, userInputPending: true };

describe("thread notification admission", () => {
  it.each([false, true])(
    "keeps input independent of completion opt-in (%s)",
    (notificationsEnabled) => {
      expect(
        getThreadNotificationKind(running, question, {
          notificationsEnabled,
          userInputNotificationsEnabled: true,
        }),
      ).toBe("user-input");
      expect(
        getThreadNotificationKind(running, question, {
          notificationsEnabled,
          userInputNotificationsEnabled: false,
        }),
      ).toBeNull();
    },
  );

  it("announces only new questions, rearming after the previous prompt resolves", () => {
    const preferences = { notificationsEnabled: false, userInputNotificationsEnabled: true };
    expect(getThreadNotificationKind(undefined, question, preferences)).toBeNull();
    expect(getThreadNotificationKind(question, { ...question }, preferences)).toBeNull();
    expect(getThreadNotificationKind(question, running, preferences)).toBeNull();
    expect(getThreadNotificationKind(running, question, preferences)).toBe("user-input");
    expect(getThreadNotificationKind(running, idle, preferences)).toBeNull();
  });

  it("keeps questions distinct from completion and retires obsolete candidates", () => {
    const preferences = { notificationsEnabled: true, userInputNotificationsEnabled: false };
    expect(getThreadNotificationKind(running, idle, preferences)).toBe("completion");
    expect(
      getThreadNotificationKind(running, { ...question, running: false }, preferences),
    ).toBeNull();
    expect(isThreadNotificationPending("user-input", question)).toBe(true);
    expect(isThreadNotificationPending("user-input", running)).toBe(false);
    expect(isThreadNotificationPending("completion", running)).toBe(false);
    expect(isThreadNotificationPending("completion", { ...question, running: false })).toBe(false);
    expect(isThreadNotificationPending("completion", idle)).toBe(true);
  });

  it("recognizes a new turn's question even when no intermediate cleared snapshot was observed", () => {
    const preferences = { notificationsEnabled: false, userInputNotificationsEnabled: true };
    expect(
      getThreadNotificationKind(
        { ...question, turnId: TurnId.make("turn-one") },
        { ...question, turnId: TurnId.make("turn-two") },
        preferences,
      ),
    ).toBe("user-input");
  });
});
