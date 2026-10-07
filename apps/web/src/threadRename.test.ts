import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readApi: vi.fn(), dispatch: vi.fn() }));
vi.mock("./environmentApi", () => ({ readEnvironmentApi: mocks.readApi }));
vi.mock("./lib/utils", () => ({ newCommandId: () => "rename-command" }));
import { renameThread } from "./threadRename";

const target = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readApi.mockReturnValue({ orchestration: { dispatchCommand: mocks.dispatch } });
  mocks.dispatch.mockResolvedValue(undefined);
});
describe("renameThread", () => {
  it("sends one trimmed metadata command to the exact environment", async () => {
    await renameThread(target, "  New title  ", "Old title");
    expect(mocks.readApi).toHaveBeenCalledWith(target.environmentId);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "thread.meta.update",
      commandId: "rename-command",
      threadId: target.threadId,
      title: "New title",
    });
  });
  it("does not contact a provider for an unchanged title", async () => {
    await renameThread(target, "  Same  ", "Same");
    expect(mocks.readApi).not.toHaveBeenCalled();
  });
  it("rejects blank titles without dispatch", async () => {
    await expect(renameThread(target, " \n ", "Old")).rejects.toThrow("can't be empty");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("reports unavailable environments rather than pretending the rename succeeded", async () => {
    mocks.readApi.mockReturnValue(null);
    await expect(renameThread(target, "New", "Old")).rejects.toThrow("Reconnect");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("propagates command failure without retrying or changing other thread state", async () => {
    mocks.dispatch.mockRejectedValue(new Error("Unavailable"));
    await expect(renameThread(target, "New", "Old")).rejects.toThrow("Unavailable");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
});
