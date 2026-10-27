import {
  EnvironmentId,
  ThreadId,
  type GlideControlInput,
  type GlideControlResult,
} from "@cafecode/contracts";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { buildThreadRouteParams } from "../threadRoutes";
import { GlideTrayNavigation } from "./GlideTrayNavigation";

const fixture = vi.hoisted(() => ({
  environmentId: "primary-host",
  reads: [] as string[],
  control: vi.fn(
    async (_input: GlideControlInput): Promise<GlideControlResult> => ({}) as GlideControlResult,
  ),
  navigate: vi.fn(async (_options: unknown): Promise<void> => undefined),
}));
vi.mock("../environments/primary", () => ({
  usePrimaryEnvironmentId: () => fixture.environmentId,
}));
vi.mock("../env", () => ({ isElectron: true }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: fixture.navigate }) }));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: (id: string) => {
    fixture.reads.push(id);
    return { glide: { control: fixture.control } };
  },
}));
beforeEach(() => {
  fixture.reads = [];
  fixture.control.mockReset();
  fixture.navigate.mockReset();
});
const navigation = { id: "server-minted-receipt", threadId: ThreadId.make("owned-chat") };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it("opens the primary host's exact chat and acknowledges only after navigation completes", async () => {
  const entered = deferred<void>(),
    finished = deferred<void>();
  fixture.control.mockImplementation(
    async (input) =>
      ({ ...(input.action === "activity" ? { navigation } : {}) }) as GlideControlResult,
  );
  fixture.navigate.mockImplementation(async () => {
    entered.resolve();
    await finished.promise;
  });
  const view = await render(<GlideTrayNavigation />);
  try {
    await entered.promise;
    expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(EnvironmentId.make(fixture.environmentId), navigation.threadId),
      ),
    });
    expect(fixture.reads.every((id) => id === fixture.environmentId)).toBe(true);
    expect(fixture.control.mock.calls.some(([input]) => input.action === "ack-navigation")).toBe(
      false,
    );
    finished.resolve();
    await expect
      .poll(() =>
        fixture.control.mock.calls.some(
          ([input]) => input.action === "ack-navigation" && input.id === navigation.id,
        ),
      )
      .toBe(true);
  } finally {
    finished.resolve();
    await view.unmount();
  }
});
it("retires a delayed native receipt when its desktop watcher unmounts", async () => {
  const response = deferred<GlideControlResult>(),
    entered = deferred<void>();
  fixture.control.mockImplementation(async (input) => {
    if (input.action === "activity") {
      entered.resolve();
      return response.promise;
    }
    return {} as GlideControlResult;
  });
  const view = await render(<GlideTrayNavigation />);
  try {
    await entered.promise;
    await view.unmount();
    const pendingRead = fixture.control.mock.results.at(-1)!.value;
    response.resolve({ navigation } as GlideControlResult);
    await pendingRead;
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.control.mock.calls.some(([input]) => input.action === "ack-navigation")).toBe(
      false,
    );
  } finally {
    response.resolve({} as GlideControlResult);
  }
});
