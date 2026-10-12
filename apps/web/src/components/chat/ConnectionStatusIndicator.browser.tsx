import "../../index.css";

import { EnvironmentId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  recordWsConnectionOpened,
  recordWsRetryScheduled,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";

const PRIMARY_ID = EnvironmentId.make("connection-chip-primary");
const SAVED_ID = EnvironmentId.make("connection-chip-saved");

describe.each(["light", "dark"])("ConnectionStatusIndicator in %s", (theme) => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;
  let previousClassName = "";

  beforeEach(() => {
    previousClassName = document.documentElement.className;
    document.documentElement.classList.toggle("dark", theme === "dark");
    resetWsConnectionStateForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    writePrimaryEnvironmentDescriptor({
      environmentId: PRIMARY_ID,
      label: "Primary fixture",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    });
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    resetWsConnectionStateForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    resetPrimaryEnvironmentDescriptorForTests();
    document.documentElement.className = previousClassName;
    document.body.innerHTML = "";
  });

  it("shows the enforcing attempt count and capped deadline beyond the old ceiling", async () => {
    recordWsConnectionOpened({ connectionLabel: "Primary fixture" });
    recordWsRetryScheduled({
      retryIndex: 37,
      delayMs: 64_000,
      nextRetryAt: new Date(Date.now() + 64_000).toISOString(),
    });
    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionStatusIndicator environmentId={PRIMARY_ID} />
      </AppAtomRegistryProvider>,
    );

    const chip = page.getByRole("button", { name: "Connection Reconnecting" });
    await expect.element(chip).toBeVisible();
    await chip.click();
    await expect.element(page.getByText("38 attempts", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Next attempt in \d+s/)).toBeVisible();
    expect(document.body.textContent).not.toContain("Retries exhausted");
    expect(document.body.textContent).not.toContain("38/8");
    await expect.element(page.getByRole("button", { name: "Retry now" })).toBeVisible();
  });

  it("keeps a saved credential rejection terminal while the primary is healthy", async () => {
    recordWsConnectionOpened();
    useSavedEnvironmentRuntimeStore.getState().patch(SAVED_ID, {
      connectionState: "error",
      connectedAt: "2026-10-10T12:00:00.000Z",
      disconnectedAt: "2026-10-10T12:01:00.000Z",
      lastError: "The server rejected the saved sign-in credential.",
      lastErrorAt: "2026-10-10T12:01:00.000Z",
      nextRetryAt: null,
      reconnectAttemptCount: 1,
      reconnectPhase: "exhausted",
    });
    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionStatusIndicator environmentId={SAVED_ID} />
      </AppAtomRegistryProvider>,
    );

    const chip = page.getByRole("button", { name: "Connection Disconnected" });
    await expect.element(chip).toBeVisible();
    await chip.click();
    await expect
      .element(page.getByText("Automatic reconnect paused. Check the connection, then retry."))
      .toBeVisible();
    await expect
      .element(page.getByText("The server rejected the saved sign-in credential."))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Next attempt in");
    expect(document.body.textContent).not.toContain("retries when you're back");
    await expect.element(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  });
});
