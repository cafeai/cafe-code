import "../../index.css";
import { ApprovalRequestId, type ProviderInteraction } from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerInteractionCard } from "./ComposerInteractionCard";
const requestId = ApprovalRequestId.make("request");
describe("private provider interaction cards", () => {
  it("requires valid form content and sends only the explicit typed response", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction: ProviderInteraction = {
      kind: "elicitation",
      mode: "form",
      serverName: "connector",
      message: "<script>provider text is inert</script>",
      fields: [
        { id: "count", title: "Count", type: "integer", required: true, minimum: 1, maximum: 4 },
      ],
    };
    const screen = await render(
      <ComposerInteractionCard
        requestId={requestId}
        interaction={interaction}
        onRespondToInteraction={respond}
      />,
    );
    try {
      expect(
        document.querySelector('section[aria-label="Provider interaction"] script'),
      ).toBeNull();
      await page.getByRole("button", { name: "Submit response" }).click();
      expect(respond).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Complete the required fields");
      await page.getByRole("spinbutton", { name: "Count (required)" }).fill("2");
      await page.getByRole("button", { name: "Submit response" }).click();
      expect(respond).toHaveBeenCalledWith(requestId, { action: "accept", content: { count: 2 } });
    } finally {
      await screen.unmount();
    }
  });
  it("does not resolve or open URLs automatically, and validates the returned origin", async () => {
    const resolve = vi.fn().mockResolvedValue("https://other.example/?token=private");
    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction: ProviderInteraction = {
      kind: "elicitation",
      mode: "url",
      serverName: "connector",
      message: "External authorization required",
      urlOrigin: "https://example.com",
    };
    const screen = await render(
      <ComposerInteractionCard
        requestId={requestId}
        interaction={interaction}
        onRespondToInteraction={respond}
        onResolveInteractionUrl={resolve}
      />,
    );
    try {
      expect(resolve).not.toHaveBeenCalled();
      expect(document.querySelector('a[href*="token="]')).toBeNull();
      await page.getByRole("button", { name: "Get authorization link" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("authorization link is unavailable");
      expect(document.querySelector('a[href*="token="]')).toBeNull();
      resolve.mockResolvedValue("https://example.com/authorize?token=private");
      await page.getByRole("button", { name: "Get authorization link" }).click();
      await expect
        .element(page.getByRole("link", { name: "Open authorization page" }))
        .toHaveAttribute("rel", "noopener noreferrer");
      expect(document.body.textContent).not.toContain("token=private");
      expect(respond).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "I completed the external step" }).click();
      expect(respond).toHaveBeenCalledWith(requestId, { action: "accept", content: null });
    } finally {
      await screen.unmount();
    }
  });
  it("starts with no permission grants selected and defaults to turn-only scope", async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    const interaction: ProviderInteraction = {
      kind: "permissions",
      message: "More access needed",
      cwd: "/workspace",
      grants: [
        { id: "read:0", label: "Read /workspace/input" },
        { id: "network", label: "Network access" },
      ],
    };
    const screen = await render(
      <ComposerInteractionCard
        requestId={requestId}
        interaction={interaction}
        onRespondToInteraction={respond}
      />,
    );
    try {
      await expect
        .element(page.getByRole("checkbox", { name: "Network access" }))
        .not.toBeChecked();
      await page.getByRole("checkbox", { name: "Read /workspace/input" }).click();
      await page.getByRole("button", { name: "Grant selected permissions" }).click();
      expect(respond).toHaveBeenCalledWith(requestId, {
        action: "accept",
        grantIds: ["read:0"],
        scope: "turn",
      });
    } finally {
      await screen.unmount();
    }
  });
});
