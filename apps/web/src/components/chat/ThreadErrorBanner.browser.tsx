import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("keeps an exact thread error dismissed across snapshot-style rerenders", async () => {
    const staleError = "Recovered provider failure request-id-1";
    const screen = await render(<ThreadErrorBanner error={staleError} scopeKey="local/thread-1" />);

    try {
      await expect.element(page.getByText(staleError)).toBeVisible();
      await page.getByLabelText("Dismiss error").click();
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(<ThreadErrorBanner error={staleError} scopeKey="local/thread-1" />);
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(
        <ThreadErrorBanner error="A different provider failure" scopeKey="local/thread-1" />,
      );
      await expect.element(page.getByText("A different provider failure")).toBeVisible();

      await screen.rerender(<ThreadErrorBanner error={staleError} scopeKey="remote/thread-1" />);
      await expect.element(page.getByText(staleError)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
