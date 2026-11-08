import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { desktopThreadNotificationTag, sendDesktopNotification } from "./desktopNotifications";

afterEach(() => vi.unstubAllGlobals());

it("keeps delimiter-bearing environment and chat identities distinct", () => {
  const first = desktopThreadNotificationTag({
    environmentId: EnvironmentId.make("a-b"),
    threadId: ThreadId.make("c"),
  });
  const second = desktopThreadNotificationTag({
    environmentId: EnvironmentId.make("a"),
    threadId: ThreadId.make("b-c"),
  });
  expect(first).not.toBe(second);
});

it("returns finite failure for absent bridges, malformed results and opaque exceptions", async () => {
  const input = { title: "Chat", body: "Finished running", tag: "test-owned" };
  const show = vi.fn();
  vi.stubGlobal("window", { desktopBridge: { showNotification: show } });
  const opaque = {
    toString: vi.fn(() => {
      throw new Error("must not coerce");
    }),
  };
  show.mockRejectedValueOnce(opaque);
  await expect(sendDesktopNotification(input)).resolves.toBe("failed");
  expect(opaque.toString).not.toHaveBeenCalled();
  show.mockResolvedValueOnce({ message: "opaque native failure" });
  await expect(sendDesktopNotification(input)).resolves.toBe("failed");
  vi.stubGlobal("window", {});
  await expect(sendDesktopNotification(input)).resolves.toBe("unsupported");
});
