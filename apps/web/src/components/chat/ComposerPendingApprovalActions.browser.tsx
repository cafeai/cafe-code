import "../../index.css";
import { ApprovalRequestId } from "@cafecode/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { createChatViewFixtureRetirement } from "../chatViewFixtureRetirement.test.fixture";

const fixtureRetirement = createChatViewFixtureRetirement();

/** Own the original render and native input before their first acquisition.
 * The same public-signal cleanup is joined by afterEach before the next case
 * can expose another approval with identically named controls. */
function createApprovalFixture(context: TestContext) {
  fixtureRetirement.assertIdle();
  let retired = false;
  let rendering: ReturnType<typeof render> | undefined;
  let completion: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const assertActive = () => {
    if (retired || context.signal.aborted) throw new Error("Approval fixture has retired");
  };
  const own = async <T,>(start: () => PromiseLike<T>): Promise<T> => {
    assertActive();
    const original = Promise.resolve(start());
    pending.add(original);
    try {
      const result = await original;
      assertActive();
      return result;
    } finally {
      pending.delete(original);
    }
  };
  const cleanup = (): Promise<void> => {
    if (completion) return completion;
    retired = true;
    completion = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      // A render fulfilled after retirement still belongs to this exact owner.
      const settled = rendering ? (await Promise.allSettled([rendering]))[0] : undefined;
      if (settled?.status === "fulfilled") await settled.value.unmount();
      context.signal.removeEventListener("abort", onAbort);
    });
    return completion;
  };
  const onAbort = () => {
    void cleanup().catch(() => undefined);
  };
  fixtureRetirement.admit(cleanup);
  context.onTestFinished(cleanup);
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  return {
    own,
    cleanup,
    mount(node: ReactNode) {
      return own(() => {
        if (rendering) throw new Error("Approval fixture already owns a render");
        rendering = render(node);
        return rendering;
      });
    },
  };
}

beforeEach(() => fixtureRetirement.assertIdle());
afterEach(() => fixtureRetirement.retire());

describe("provider approval safety hints", () => {
  it("focuses decline and omits reusable grants for sensitive asks", async (context) => {
    const owner = createApprovalFixture(context);
    const respond = vi.fn().mockResolvedValue(undefined);
    try {
      await owner.mount(
        <>
          <ComposerPendingApprovalPanel
            approval={{
              requestId: ApprovalRequestId.make("sensitive"),
              requestKind: "command",
              createdAt: "2026-11-03T00:00:00.000Z",
              defaultToNo: true,
              suppressAlwaysAllowRule: true,
            }}
            pendingCount={1}
          />
          <ComposerPendingApprovalActions
            requestId={ApprovalRequestId.make("sensitive")}
            isResponding={false}
            defaultToNo
            suppressAlwaysAllowRule
            onRespondToApproval={respond}
          />
        </>,
      );
      await owner.own(() =>
        expect.element(page.getByRole("button", { name: "Decline", exact: true })).toHaveFocus(),
      );
      await owner.own(() =>
        expect
          .element(
            page.getByText(
              "Your provider requested a one-time confirmation. This can still appear with automatic permissions enabled.",
              { exact: true },
            ),
          )
          .toBeVisible(),
      );
      expect(document.body.textContent).not.toContain("Always allow this session");
      expect(respond).not.toHaveBeenCalled();
      await owner.own(() => page.getByRole("button", { name: "Approve once" }).click());
      expect(respond).toHaveBeenCalledWith("sensitive", "accept");
    } finally {
      await owner.cleanup();
    }
  });

  it("keeps ordinary session approval available without auto-selecting approve", async (context) => {
    const owner = createApprovalFixture(context);
    const respond = vi.fn().mockResolvedValue(undefined);
    try {
      await owner.mount(
        <>
          <ComposerPendingApprovalPanel
            approval={{
              requestId: ApprovalRequestId.make("ordinary"),
              requestKind: "command",
              createdAt: "2026-11-03T00:00:00.000Z",
            }}
            pendingCount={1}
          />
          <ComposerPendingApprovalActions
            requestId={ApprovalRequestId.make("ordinary")}
            isResponding={false}
            onRespondToApproval={respond}
          />
        </>,
      );
      await owner.own(() =>
        expect
          .element(
            page.getByText(
              "Your provider requested a one-time confirmation. This can still appear with automatic permissions enabled.",
              { exact: true },
            ),
          )
          .not.toBeInTheDocument(),
      );
      await owner.own(() =>
        expect.element(page.getByRole("button", { name: "Approve once" })).not.toHaveFocus(),
      );
      expect(respond).not.toHaveBeenCalled();
      await owner.own(() =>
        page.getByRole("button", { name: "Always allow this session" }).click(),
      );
      expect(respond).toHaveBeenCalledWith("ordinary", "acceptForSession");
    } finally {
      await owner.cleanup();
    }
  });
});
