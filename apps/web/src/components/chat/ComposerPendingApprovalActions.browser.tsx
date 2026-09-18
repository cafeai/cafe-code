import "../../index.css";
import { ApprovalRequestId } from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("provider approval safety hints", () => {
  it("focuses decline and omits reusable grants for sensitive asks", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const screen = await render(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("sensitive")}
        isResponding={false}
        defaultToNo
        suppressAlwaysAllowRule
        onRespondToApproval={respond}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Decline", exact: true }))
        .toHaveFocus();
      expect(document.body.textContent).not.toContain("Always allow this session");
      expect(respond).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Approve once" }).click();
      expect(respond).toHaveBeenCalledWith("sensitive", "accept");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps ordinary session approval available without auto-selecting approve", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const screen = await render(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("ordinary")}
        isResponding={false}
        onRespondToApproval={respond}
      />,
    );
    try {
      await expect.element(page.getByRole("button", { name: "Approve once" })).not.toHaveFocus();
      await page.getByRole("button", { name: "Always allow this session" }).click();
      expect(respond).toHaveBeenCalledWith("ordinary", "acceptForSession");
    } finally {
      await screen.unmount();
    }
  });
});
