import "../../index.css";

import { EnvironmentId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";
import { SavedEnvironmentsSettings } from "./SavedEnvironmentsSettings";

const runtimeMocks = vi.hoisted(() => ({
  addSavedEnvironment: vi.fn(),
  reconnectSavedEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
}));

vi.mock("../../environments/runtime", async () => {
  const catalog = await import("../../environments/runtime/catalog");
  return {
    ...catalog,
    ...runtimeMocks,
  };
});

describe("SavedEnvironmentsSettings", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(() => {
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    runtimeMocks.addSavedEnvironment.mockReset();
    runtimeMocks.reconnectSavedEnvironment.mockReset().mockResolvedValue(undefined);
    runtimeMocks.disconnectSavedEnvironment.mockReset().mockResolvedValue(undefined);
    runtimeMocks.removeSavedEnvironment.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const teardown = mounted?.cleanup ?? mounted?.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";
  });

  it("opens the add dialog and switches pairing methods", async () => {
    mounted = await render(<SavedEnvironmentsSettings />);

    await page.getByRole("button", { name: "Add environment" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByLabelText("Pairing URL")).toBeVisible();

    await page.getByRole("button", { name: "Host + Code" }).click();
    await expect.element(page.getByLabelText("Host")).toBeVisible();
    await expect.element(page.getByLabelText("Pairing code")).toBeVisible();
  });

  it("clears pairing secrets immediately and closes after a successful add", async () => {
    let resolveAdd!: (record: SavedEnvironmentRecord) => void;
    runtimeMocks.addSavedEnvironment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    mounted = await render(<SavedEnvironmentsSettings />);

    await page.getByRole("button", { name: "Add environment" }).click();
    await page.getByLabelText("Label (optional)").fill("My test environment");
    await page
      .getByLabelText("Pairing URL")
      .fill("https://test.local/pair#token=secret-pairing-token");
    await page.getByRole("button", { name: "Add environment", exact: true }).click();

    await expect.element(page.getByLabelText("Pairing URL")).toHaveValue("");
    await expect
      .element(page.getByRole("button", { name: "Add environment", exact: true }))
      .toBeDisabled();

    resolveAdd({
      environmentId: EnvironmentId.make("env-123"),
      label: "Test environment",
      httpBaseUrl: "https://test.local/",
      wsBaseUrl: "wss://test.local/",
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
    });
    await expect.element(page.getByRole("dialog")).not.toBeVisible();
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledWith({
      label: "My test environment",
      pairingUrl: "https://test.local/pair#token=secret-pairing-token",
    });
  });

  it("does not render pairing secrets from add failures", async () => {
    runtimeMocks.addSavedEnvironment.mockRejectedValueOnce(
      new Error("Rejected secret-pairing-token from https://test.local/pair"),
    );
    mounted = await render(<SavedEnvironmentsSettings />);

    await page.getByRole("button", { name: "Add environment" }).click();
    await page
      .getByLabelText("Pairing URL")
      .fill("https://test.local/pair#token=secret-pairing-token");
    await page.getByRole("button", { name: "Add environment", exact: true }).click();

    await expect
      .element(
        page.getByText(
          "Could not add this environment. Check the server address and pairing credential, then try again.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText(/secret-pairing-token/u)).not.toBeInTheDocument();
  });

  it("handles reconnect and remove actions", async () => {
    const environmentId = EnvironmentId.make("env-123");
    useSavedEnvironmentRegistryStore.setState({
      byId: {
        [environmentId]: {
          environmentId,
          label: "My Remote Box",
          httpBaseUrl: "https://remote.local/",
          wsBaseUrl: "wss://remote.local/",
          createdAt: new Date().toISOString(),
          lastConnectedAt: null,
        },
      },
    });
    mounted = await render(<SavedEnvironmentsSettings />);

    await expect.element(page.getByText("My Remote Box")).toBeVisible();
    await expect.element(page.getByText("remote.local")).toBeVisible();
    await page.getByRole("button", { name: "Reconnect My Remote Box" }).click();
    expect(runtimeMocks.reconnectSavedEnvironment).toHaveBeenCalledWith(environmentId);

    await page.getByRole("button", { name: "Remove My Remote Box" }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    expect(runtimeMocks.removeSavedEnvironment).toHaveBeenCalledWith(environmentId);
    await expect.element(page.getByRole("alertdialog")).not.toBeVisible();
  });

  it("offers disconnect for a connected environment", async () => {
    const environmentId = EnvironmentId.make("env-connected");
    useSavedEnvironmentRegistryStore.setState({
      byId: {
        [environmentId]: {
          environmentId,
          label: "Connected server",
          httpBaseUrl: "https://connected.example/",
          wsBaseUrl: "wss://connected.example/",
          createdAt: new Date().toISOString(),
          lastConnectedAt: new Date().toISOString(),
        },
      },
    });
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      authState: "authenticated",
    });
    mounted = await render(<SavedEnvironmentsSettings />);

    await page.getByRole("button", { name: "Disconnect Connected server" }).click();
    expect(runtimeMocks.disconnectSavedEnvironment).toHaveBeenCalledWith(environmentId);
  });
});
