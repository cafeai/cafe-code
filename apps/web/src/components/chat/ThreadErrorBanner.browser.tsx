import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { EnvironmentId, ThreadId } from "@cafecode/contracts";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

// The banner also records an Atrium dismissal, which reads the store and
// settings. Neither is exercised here; this test is about the local
// per-occurrence hide surviving snapshot-style rerenders.
const ENV = "local" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;

describe("ThreadErrorBanner", () => {
  it("keeps an exact thread error dismissed across snapshot-style rerenders", async () => {
    const staleError = "Recovered provider failure request-id-1";
    const screen = await render(
      <ThreadErrorBanner
        error={staleError}
        scopeKey="local/thread-1"
        environmentId={ENV}
        threadId={THREAD}
      />,
    );

    try {
      await expect.element(page.getByText(staleError)).toBeVisible();
      await page.getByLabelText("Dismiss error").click();
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(
        <ThreadErrorBanner
          error={staleError}
          scopeKey="local/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText(staleError)).not.toBeInTheDocument();

      await screen.rerender(
        <ThreadErrorBanner
          error="A different provider failure"
          scopeKey="local/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText("A different provider failure")).toBeVisible();

      await screen.rerender(
        <ThreadErrorBanner
          error={staleError}
          scopeKey="remote/thread-1"
          environmentId={ENV}
          threadId={THREAD}
        />,
      );
      await expect.element(page.getByText(staleError)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
