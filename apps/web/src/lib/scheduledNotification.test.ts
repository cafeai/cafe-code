import type { EnvironmentApi } from "@cafecode/contracts";
import { ThreadId, TurnId } from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { shouldNotifyScheduledTurn } from "./scheduledNotification";

describe("scheduled completion notifications", () => {
  const threadId = ThreadId.make("scheduled-chat");
  const turnId = TurnId.make("exact-completed-turn");
  it("uses the exact thread and completed turn for durable notification policy", async () => {
    const notification = vi.fn().mockResolvedValue({ notify: false });
    const api = { scheduledFollowups: { notification } } as unknown as EnvironmentApi;
    expect(await shouldNotifyScheduledTurn(api, threadId, turnId)).toBe(false);
    expect(notification).toHaveBeenCalledExactlyOnceWith({ threadId, turnId });
    notification.mockResolvedValue({ notify: true });
    expect(await shouldNotifyScheduledTurn(api, threadId, turnId)).toBe(true);
  });
  it("suppresses inconclusive policy reads without replay or notification spam", async () => {
    const notification = vi.fn().mockRejectedValue(new Error("disconnected"));
    const api = { scheduledFollowups: { notification } } as unknown as EnvironmentApi;
    expect(await shouldNotifyScheduledTurn(api, threadId, turnId)).toBe(false);
    expect(notification).toHaveBeenCalledTimes(1);
    expect(await shouldNotifyScheduledTurn(undefined, threadId, turnId)).toBe(false);
  });
  it("preserves legacy backends without the scheduling capability", async () => {
    expect(await shouldNotifyScheduledTurn({} as EnvironmentApi, threadId, turnId)).toBe(true);
  });
});
