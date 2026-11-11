import "../../index.css";

import { EnvironmentId } from "@cafecode/contracts";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import { createIdentity, privateIdentityBytes } from "@cafecode/relay/crypto";
import { opaque, randomOpaque } from "@cafecode/relay/bytes";
import { RelayConnectionsSettings, type RelaySettingsRequest } from "./RelayConnectionsSettings";
import {
  selectWorkspaceEnvironment,
  resetWorkspaceEnvironmentForTests,
} from "../../environments/workspace";
import {
  readBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentRegistry,
  SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
  SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY,
} from "../../clientPersistenceStorage";
import {
  readBrowserSavedSecret,
  writeBrowserSavedSecret,
  removeBrowserSavedSecret,
} from "../../environments/relay/browserSavedSecret";
import { encodeSavedRelaySecret } from "../../environments/relay/savedSecret";
import { savedRelayUrls } from "../../environments/relay/active";
import { removeRelayTarget } from "../../environments/relay/storage";

import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";
import { SavedEnvironmentsSettings } from "./SavedEnvironmentsSettings";

const runtimeMocks = {
  addSavedEnvironment: vi.fn(),
  reconnectSavedEnvironment: vi.fn(),
  reviewSavedEnvironmentCertificate: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  updateSavedEnvironment: vi.fn(),
};

const actions = {
  add: runtimeMocks.addSavedEnvironment,
  reconnect: runtimeMocks.reconnectSavedEnvironment,
  reviewCertificate: runtimeMocks.reviewSavedEnvironmentCertificate,
  disconnect: runtimeMocks.disconnectSavedEnvironment,
  remove: runtimeMocks.removeSavedEnvironment,
  update: runtimeMocks.updateSavedEnvironment,
};

function getDialogButton(role: "dialog" | "alertdialog", name: string): HTMLButtonElement {
  const dialog = document.querySelector<HTMLElement>(`[role="${role}"]`);
  const button = Array.from(dialog?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) {
    throw new Error(`Unable to find ${name} button in ${role}.`);
  }
  return button;
}

function clickDialogButton(role: "dialog" | "alertdialog", name: string): void {
  getDialogButton(role, name).click();
}

function ownSettingsFixture({ signal, onTestFinished }: TestContext) {
  let retired = false;
  let pendingRender: ReturnType<typeof render> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const nativeOperations = new Set<Promise<unknown>>();
  const afterUnmount = new Set<() => void | Promise<void>>();
  let releasePointer: (() => Promise<void>) | null = null;
  const host = document.createElement("div");
  const assertActive = () => {
    if (retired || signal.aborted) throw new Error("Saved environment fixture retired.");
  };
  const retire = () => {
    retired = true;
    signal.removeEventListener("abort", retire);
  };
  const cleanup = () => {
    retire();
    return (cleanupPromise ??= (async () => {
      await Promise.allSettled([...nativeOperations]);
      await releasePointer?.();
      const view = await pendingRender?.catch(() => null);
      await view?.unmount();
      host.remove();
      await Promise.all([...afterUnmount].map((release) => release()));
    })());
  };
  onTestFinished(cleanup);
  signal.addEventListener("abort", retire, { once: true });
  if (signal.aborted) retire();
  return {
    cleanup,
    afterUnmount: (release: () => void | Promise<void>) => afterUnmount.add(release),
    async screenshot(path: string) {
      const previous = { width: window.innerWidth, height: window.innerHeight };
      const wasDark = document.documentElement.classList.contains("dark");
      let restoring: Promise<void> | undefined;
      const restore = () =>
        (restoring ??= (async () => {
          if (!wasDark) document.documentElement.classList.remove("dark");
          await page.viewport(previous.width, previous.height);
        })());
      afterUnmount.add(restore);
      try {
        await this.native(() => page.viewport(1200, 850));
        document.documentElement.classList.add("dark");
        await this.native(() => page.screenshot({ path }));
      } finally {
        await restore();
      }
    },
    async drag(source: HTMLElement, target: HTMLElement) {
      const point = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        let x = bounds.left + bounds.width / 2;
        let y = bounds.top + bounds.height / 2;
        let frame = window.frameElement;
        while (frame) {
          const node = frame as HTMLElement;
          const rect = node.getBoundingClientRect();
          x = rect.left + (x + node.clientLeft) * (rect.width / node.offsetWidth);
          y = rect.top + (y + node.clientTop) * (rect.height / node.offsetHeight);
          frame = frame.ownerDocument.defaultView?.frameElement ?? null;
        }
        return { x, y };
      };
      const start = point(source);
      const end = point(target);
      const input = cdp();
      let releasePromise: Promise<void> | null = null;
      const release = () =>
        (releasePromise ??= input
          .send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...end,
            button: "left",
            buttons: 0,
            clickCount: 1,
          })
          .then(() => undefined));
      releasePointer = release;
      try {
        await this.native(() =>
          input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start }),
        );
        await this.native(() =>
          input.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...start,
            button: "left",
            buttons: 1,
            clickCount: 1,
          }),
        );
        await this.native(() =>
          input.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: start.x,
            y: start.y + 10,
            button: "left",
            buttons: 1,
          }),
        );
        await expect.element(source).toHaveAttribute("aria-pressed", "true");
        for (let step = 1; step <= 8; step += 1) {
          await this.native(() =>
            input.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: start.x + ((end.x - start.x) * step) / 8,
              y: start.y + ((end.y - start.y) * step) / 8,
              button: "left",
              buttons: 1,
            }),
          );
        }
      } finally {
        await release();
      }
    },
    async mount(node: ReactNode = <SavedEnvironmentsSettings actions={actions} />) {
      assertActive();
      document.body.append(host);
      pendingRender = render(node, { container: host });
      const view = await pendingRender;
      assertActive();
      return view;
    },
    async native<T>(operation: () => Promise<T>) {
      assertActive();
      const pending = operation();
      nativeOperations.add(pending);
      try {
        const result = await pending;
        assertActive();
        return result;
      } finally {
        nativeOperations.delete(pending);
      }
    },
  };
}

describe("SavedEnvironmentsSettings", () => {
  let fixture: ReturnType<typeof ownSettingsFixture>;

  beforeEach((context) => {
    fixture = ownSettingsFixture(context);
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    resetWorkspaceEnvironmentForTests();
    runtimeMocks.addSavedEnvironment.mockReset();
    runtimeMocks.reconnectSavedEnvironment.mockReset().mockResolvedValue(undefined);
    runtimeMocks.reviewSavedEnvironmentCertificate.mockReset().mockResolvedValue(undefined);
    runtimeMocks.disconnectSavedEnvironment.mockReset().mockResolvedValue(undefined);
    runtimeMocks.removeSavedEnvironment.mockReset().mockResolvedValue(undefined);
    runtimeMocks.updateSavedEnvironment.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await fixture.cleanup();
    resetWorkspaceEnvironmentForTests();
    document.body.innerHTML = "";
  });

  it("hosts with one toggle, keeps network management collapsed, and issues a client invitation", async () => {
    const networkId = randomOpaque();
    let status = {
      enabled: false,
      phase: "off",
      networks: [] as { networkId: string; serving: number }[],
    };
    const request = vi.fn<RelaySettingsRequest>(async (path, init) => {
      if (path === "/api/relay/invitations")
        return {
          id: randomOpaque(16),
          url: "https://relay.cafecode.sh/relay/connect#synthetic-private-invitation",
          expiresAt: Date.now() + 60_000,
        };
      if (init.method === "POST" && path === "/api/relay") {
        const enabled = JSON.parse(String(init.body)).enabled;
        status = {
          enabled,
          phase: enabled ? "connected" : "off",
          networks: enabled ? [{ networkId, serving: 1 }] : [],
        };
      }
      return status;
    });
    await fixture.mount(
      <div className="mx-auto max-w-3xl space-y-8 p-8">
        <SavedEnvironmentsSettings actions={actions} />
        <RelayConnectionsSettings request={request} />
      </div>,
    );
    const toggle = page.getByRole("switch", { name: "Relay", exact: true });
    await expect.element(toggle).toBeEnabled();
    await expect.element(toggle).not.toBeChecked();
    await expect.element(page.getByLabelText("Custom relay networks")).not.toBeVisible();
    await fixture.native(() => toggle.click());
    await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
    await fixture.native(() =>
      page.getByRole("button", { name: "Create relay invitation" }).click(),
    );
    await expect
      .element(page.getByLabelText("Relay invitation link"))
      .toHaveValue("https://relay.cafecode.sh/relay/connect#synthetic-private-invitation");
    expect(request).toHaveBeenCalledWith("/api/relay/invitations", {
      method: "POST",
      body: JSON.stringify({ networkId, role: "client" }),
    });
    await fixture.native(() => page.getByText("Advanced relay settings", { exact: true }).click());
    await expect.element(page.getByLabelText("Custom relay networks")).toBeVisible();
    await fixture.native(() => page.getByRole("button", { name: "Save relay network" }).click());
    await expect
      .poll(() =>
        request.mock.calls.some(
          ([path, init]) =>
            path === "/api/relay/networks" && init.body === JSON.stringify({ networks: [] }),
        ),
      )
      .toBe(true);
    await fixture.native(() => page.getByText("Advanced relay settings", { exact: true }).click());
    if (import.meta.env.VITE_RELAY_SCREENSHOTS === "1")
      await fixture.screenshot("../../../../../.explorations/relay/connections-hosting.png");
    await fixture.native(() => toggle.click());
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Create relay invitation" }))
      .not.toBeInTheDocument();
  });

  it("does not apply an old host-toggle acknowledgement after switching environments", async () => {
    let resolveHeld!: (value: unknown) => void;
    const held = {
      promise: new Promise<unknown>((resolve) => {
        resolveHeld = resolve;
      }),
      resolve: (value: unknown) => resolveHeld(value),
    };
    fixture.afterUnmount(() => held.resolve({ enabled: false, networks: [] }));
    const request = vi.fn<RelaySettingsRequest>((_path, init) =>
      init.method === "POST" ? held.promise : Promise.resolve({ enabled: false, networks: [] }),
    );
    await fixture.mount(<RelayConnectionsSettings request={request} />);
    const toggle = page.getByRole("switch", { name: "Relay", exact: true });
    await expect.element(toggle).toBeEnabled();
    await fixture.native(() => toggle.click());
    await expect.element(toggle).toBeDisabled();
    selectWorkspaceEnvironment(EnvironmentId.make("other-test-owned-environment"));
    await expect.element(toggle).toBeEnabled();
    held.resolve({
      enabled: true,
      phase: "connected",
      networks: [{ networkId: randomOpaque(), serving: 1 }],
    });
    await held.promise;
    await expect.element(toggle).not.toBeChecked();
  });

  it("adds a relay host through Saved environments and clears its one-use invitation immediately", async () => {
    let resolveAdded!: (value: SavedEnvironmentRecord) => void;
    const added = {
      promise: new Promise<SavedEnvironmentRecord>((resolve) => {
        resolveAdded = resolve;
      }),
      resolve: (value: SavedEnvironmentRecord) => resolveAdded(value),
    };
    const record = {
      transport: "relay" as const,
      environmentId: EnvironmentId.make("relay-test-environment"),
      label: "My Cafe",
      ...savedRelayUrls(randomOpaque()),
      createdAt: "2026-11-10T00:00:00.000Z",
      lastConnectedAt: null,
    };
    fixture.afterUnmount(() => added.resolve(record));
    runtimeMocks.addSavedEnvironment.mockReturnValueOnce(added.promise);
    await fixture.mount();
    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    const dialog = page.getByRole("dialog");
    await fixture.native(() =>
      dialog.getByRole("button", { name: "Relay host", exact: true }).click(),
    );
    await expect.element(dialog.getByLabelText("Relay invitation")).toBeVisible();
    await fixture.native(() => dialog.getByLabelText("Label (optional)").fill("My Cafe"));
    await fixture.native(() =>
      dialog
        .getByLabelText("Relay invitation")
        .fill("https://relay.cafecode.sh/relay/connect#test-owned-one-use-secret"),
    );
    if (import.meta.env.VITE_RELAY_SCREENSHOTS === "1")
      await fixture.screenshot("../../../../../.explorations/relay/add-relay-environment.png");
    await fixture.native(() =>
      dialog.getByRole("button", { name: "Add environment", exact: true }).click(),
    );
    await expect.element(dialog.getByLabelText("Relay invitation")).toHaveValue("");
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledExactlyOnceWith({
      label: "My Cafe",
      relayInvitation: "https://relay.cafecode.sh/relay/connect#test-owned-one-use-secret",
    });
    added.resolve(record);
    useSavedEnvironmentRegistryStore.getState().upsert(record);
    await expect.element(page.getByText("Relay connection", { exact: true })).toBeVisible();
    await fixture.native(() => page.getByRole("button", { name: "Edit My Cafe" }).click());
    await expect
      .element(page.getByRole("dialog").getByLabelText("Name", { exact: true }))
      .toHaveValue("My Cafe");
    await expect
      .element(page.getByRole("dialog").getByLabelText("Host", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("wraps saved relay device keys in tab ciphertext and removes the exact capability", async () => {
    let targetId: string | undefined;
    const registry = localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
    const slots = sessionStorage.getItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY);
    fixture.afterUnmount(async () => {
      if (targetId) await removeRelayTarget(targetId);
      if (registry === null) localStorage.removeItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
      else localStorage.setItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY, registry);
      if (slots === null) sessionStorage.removeItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY);
      else sessionStorage.setItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY, slots);
    });
    const identity = await fixture.native(() => createIdentity());
    targetId = randomOpaque();
    const environmentId = EnvironmentId.make(randomOpaque());
    const target = {
      id: targetId,
      networkId: randomOpaque(),
      rootPublicKey: randomOpaque(),
      bootstrapUrls: ["https://relay.example/v1/network"],
      minimumRevision: 1,
      hostPublicKey: randomOpaque(),
      environmentId,
      locator: randomOpaque(),
      preferredNodeId: randomOpaque(),
      bearerToken: "test-only-browser-relay-bearer",
      tickets: [],
    };
    const record = {
      transport: "relay" as const,
      environmentId,
      label: "Relay browser fixture",
      ...savedRelayUrls(targetId),
      createdAt: "2026-11-10T00:00:00.000Z",
      lastConnectedAt: null,
    };
    writeBrowserSavedEnvironmentRegistry([record]);
    const secret = encodeSavedRelaySecret(target, identity);
    expect(await fixture.native(() => writeBrowserSavedSecret(environmentId, secret))).toBe(true);
    expect(readBrowserSavedEnvironmentRegistry()).toEqual([record]);
    const rawSlots = sessionStorage.getItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY)!;
    const rawCiphertext = sessionStorage.getItem("cafe-relay-target:" + targetId)!;
    for (const raw of [
      rawSlots,
      rawCiphertext,
      localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!,
    ]) {
      expect(raw).not.toContain(target.bearerToken);
      expect(raw).not.toContain(opaque(privateIdentityBytes(identity)));
    }
    expect(await fixture.native(() => readBrowserSavedSecret(environmentId))).toBe(secret);
    await fixture.native(() => removeBrowserSavedSecret(environmentId));
    expect(sessionStorage.getItem("cafe-relay-target:" + targetId)).toBeNull();
    expect(await fixture.native(() => readBrowserSavedSecret(environmentId))).toBeNull();
  });

  it("warns about a changed certificate and reviews it only after an explicit click", async () => {
    const environmentId = EnvironmentId.make("certificate-pc");
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Certificate PC",
      httpBaseUrl: "https://pc.example:13775/",
      wsBaseUrl: "wss://pc.example:13775/",
      createdAt: "2026-11-04T00:00:00.000Z",
      lastConnectedAt: null,
    });
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "error",
      reconnectPhase: "exhausted",
      certificateStatus: "changed",
    });
    let finish!: () => void;
    runtimeMocks.reviewSavedEnvironmentCertificate.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await fixture.mount();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByText("Certificate changed", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "intercepting your connection",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "saved sign-in credential",
    );
    expect(runtimeMocks.reviewSavedEnvironmentCertificate).not.toHaveBeenCalled();
    const review = page.getByRole("button", { name: "Review certificate" });
    await fixture.native(() => review.click());
    expect(runtimeMocks.reviewSavedEnvironmentCertificate).toHaveBeenCalledExactlyOnceWith(
      environmentId,
    );
    await expect.element(review).toBeDisabled();
    finish();
    await expect.element(review).toBeEnabled();
    expect(runtimeMocks.reconnectSavedEnvironment).not.toHaveBeenCalled();
  });

  it("blocks invalid certificates without offering trust and permits retry after repair", async () => {
    const environmentId = EnvironmentId.make("invalid-certificate-pc");
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Invalid certificate PC",
      httpBaseUrl: "https://pc.example:13775/",
      wsBaseUrl: "wss://pc.example:13775/",
      createdAt: "2026-11-04T00:00:00.000Z",
      lastConnectedAt: null,
    });
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "error",
      certificateStatus: "invalid-certificate",
    });
    await fixture.mount();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "expired, invalid, or for another address",
    );
    await expect
      .element(page.getByRole("button", { name: "Review certificate" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Reconnect Invalid certificate PC" }))
      .toBeEnabled();
    expect(runtimeMocks.reviewSavedEnvironmentCertificate).not.toHaveBeenCalled();
  });

  it("opens the add dialog and switches pairing methods", async () => {
    await fixture.mount();

    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByLabelText("Pairing URL")).toBeVisible();

    await fixture.native(() => page.getByRole("button", { name: "Host + Code" }).click());
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
    await fixture.mount();

    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    const dialog = page.getByRole("dialog");
    await fixture.native(() =>
      dialog.getByLabelText("Label (optional)").fill("My test environment"),
    );
    await fixture.native(() =>
      dialog
        .getByLabelText("Pairing URL")
        .fill("https://test.local/pair#token=secret-pairing-token"),
    );
    await fixture.native(() =>
      dialog.getByLabelText("Authenticator or recovery code").fill("123456"),
    );
    const nativeDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const nativeFactorInput = nativeDialog?.querySelector<HTMLInputElement>("#env-second-factor");
    const nativePairingInput = Array.from(nativeDialog?.querySelectorAll("input") ?? []).find(
      (input) => input.value.includes("secret-pairing-token"),
    );
    const submitButton = getDialogButton("dialog", "Add environment");
    submitButton.click();

    await vi.waitFor(() => {
      expect(nativePairingInput?.value).toBe("");
      expect(nativeFactorInput?.value).toBe("");
      expect(submitButton.disabled).toBe(true);
      // The label keeps its width while pending; the button reports busy instead.
      expect(submitButton.getAttribute("aria-busy")).toBe("true");
      expect(nativeDialog?.isConnected).toBe(true);
      expect(nativeDialog?.hasAttribute("data-open")).toBe(true);
    });

    resolveAdd({
      environmentId: EnvironmentId.make("env-123"),
      label: "Test environment",
      httpBaseUrl: "https://test.local/",
      wsBaseUrl: "wss://test.local/",
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
    });
    await vi.waitFor(() => {
      const remainingDialog = document.querySelector('[role="dialog"]');
      if (remainingDialog === null) return;
      // Base UI may retain the closed popup for its native exit transition.
      // Test the successful closure, not compositor-dependent portal removal.
      expect(remainingDialog).toBe(nativeDialog);
      expect(remainingDialog.hasAttribute("data-closed")).toBe(true);
      expect(remainingDialog.hasAttribute("data-open")).toBe(false);
    });
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledOnce();
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledWith({
      label: "My test environment",
      pairingUrl: "https://test.local/pair#token=secret-pairing-token",
      secondFactor: "123456",
    });
  });

  it("does not render pairing secrets from add failures", async () => {
    runtimeMocks.addSavedEnvironment.mockRejectedValueOnce(
      new Error("Rejected secret-pairing-token from https://test.local/pair"),
    );
    await fixture.mount();

    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    const dialog = page.getByRole("dialog");
    await fixture.native(() =>
      dialog
        .getByLabelText("Pairing URL")
        .fill("https://test.local/pair#token=secret-pairing-token"),
    );
    clickDialogButton("dialog", "Add environment");

    await expect
      .element(
        page.getByText(
          "Could not add this environment. Check the server address and pairing credential, then try again.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText(/secret-pairing-token/u)).not.toBeInTheDocument();
  });

  it("submits login credentials once, clears the password while pending, and closes on success", async () => {
    let resolveAdd!: (record: SavedEnvironmentRecord) => void;
    runtimeMocks.addSavedEnvironment.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    await fixture.mount();
    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    await fixture.native(() => page.getByRole("button", { name: "Host + Password" }).click());
    const dialog = page.getByRole("dialog");
    await fixture.native(() => dialog.getByLabelText("Host").fill("https://pc.example:3775"));
    expect(document.querySelector("#env-username")).toBeNull();
    await fixture.native(() => dialog.getByLabelText("Admin password").fill("admin-secret"));
    const passwordInput = document.querySelector<HTMLInputElement>("#env-password");
    expect(passwordInput?.type).toBe("password");
    const submitButton = getDialogButton("dialog", "Add environment");
    submitButton.click();
    await vi.waitFor(() => {
      expect(passwordInput?.value).toBe("");
      expect(submitButton.disabled).toBe(true);
    });
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledExactlyOnceWith({
      label: "",
      host: "https://pc.example:3775",
      password: "admin-secret",
    });
    resolveAdd({
      environmentId: EnvironmentId.make("pc"),
      label: "PC",
      httpBaseUrl: "https://pc.example:3775/",
      wsBaseUrl: "wss://pc.example:3775/",
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it("sanitizes login failures and requires a fresh password for retry", async () => {
    runtimeMocks.addSavedEnvironment.mockRejectedValue(
      new Error("Rejected admin-secret for PC user at https://pc.example/private"),
    );
    await fixture.mount();
    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    await fixture.native(() => page.getByRole("button", { name: "Host + Password" }).click());
    const dialog = page.getByRole("dialog");
    await fixture.native(() => dialog.getByLabelText("Host").fill("https://pc.example"));
    await fixture.native(() => dialog.getByLabelText("Admin password").fill("admin-secret"));
    clickDialogButton("dialog", "Add environment");
    await expect
      .element(
        page.getByText(
          "Could not sign in. Check the server address and admin password, then try again.",
        ),
      )
      .toBeVisible();
    expect(document.querySelector<HTMLInputElement>("#env-password")?.value).toBe("");
    expect(document.body.textContent).not.toMatch(/admin-secret|PC user|\/private/);
    clickDialogButton("dialog", "Add environment");
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledOnce();
    await fixture.native(() => dialog.getByLabelText("Admin password").fill("fresh-secret"));
    clickDialogButton("dialog", "Add environment");
    await vi.waitFor(() => {
      expect(runtimeMocks.addSavedEnvironment).toHaveBeenCalledTimes(2);
    });
    expect(runtimeMocks.addSavedEnvironment).toHaveBeenLastCalledWith({
      label: "",
      host: "https://pc.example",
      password: "fresh-secret",
    });
  });

  it("discards login and pairing secrets when switching methods or closing", async () => {
    await fixture.mount();
    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    const dialog = page.getByRole("dialog");
    await fixture.native(() =>
      dialog.getByLabelText("Pairing URL").fill("https://pc.example/pair#token=secret"),
    );
    await fixture.native(() => page.getByRole("button", { name: "Host + Password" }).click());
    await fixture.native(() => dialog.getByLabelText("Admin password").fill("admin-secret"));
    await fixture.native(() =>
      page.getByRole("button", { name: "Pairing URL", exact: true }).click(),
    );
    await expect.element(dialog.getByLabelText("Pairing URL")).toHaveValue("");
    await fixture.native(() => page.getByRole("button", { name: "Host + Password" }).click());
    await expect.element(dialog.getByLabelText("Admin password")).toHaveValue("");
    await fixture.native(() => dialog.getByLabelText("Admin password").fill("second-secret"));
    await fixture.native(() => dialog.getByRole("button", { name: "Cancel" }).click());
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
    await fixture.native(() => page.getByRole("button", { name: "Host + Password" }).click());
    await expect.element(page.getByLabelText("Admin password")).toHaveValue("");
    expect(runtimeMocks.addSavedEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    [320, 640],
    [1100, 780],
  ])("keeps login actions visible at %s × %s", async (width, height) => {
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await fixture.native(() => page.viewport(width, height));
    try {
      await fixture.mount();
      await fixture.native(() => page.getByRole("button", { name: "Add environment" }).click());
      await fixture.native(() => page.getByRole("button", { name: "Host + Password" }).click());
      await vi.waitFor(() => {
        for (const name of ["Cancel", "Add environment"]) {
          const bounds = getDialogButton("dialog", name).getBoundingClientRect();
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeLessThanOrEqual(height);
          expect(bounds.left).toBeGreaterThanOrEqual(0);
          expect(bounds.right).toBeLessThanOrEqual(width);
        }
      });
      await fixture.native(() =>
        page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click(),
      );
      await vi.waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });
    } finally {
      await fixture.native(() => page.viewport(previous.width, previous.height));
    }
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
    await fixture.mount();

    await expect.element(page.getByText("My Remote Box")).toBeVisible();
    await expect.element(page.getByText("remote.local")).toBeVisible();
    await fixture.native(() =>
      page.getByRole("button", { name: "Reconnect My Remote Box" }).click(),
    );
    expect(runtimeMocks.reconnectSavedEnvironment).toHaveBeenCalledWith(environmentId);

    await fixture.native(() => page.getByRole("button", { name: "Edit My Remote Box" }).click());
    await fixture.native(() =>
      page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
    );
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    clickDialogButton("alertdialog", "Remove");
    expect(runtimeMocks.removeSavedEnvironment).toHaveBeenCalledWith(environmentId);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
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
    await fixture.mount();

    await fixture.native(() =>
      page.getByRole("button", { name: "Disconnect Connected server" }).click(),
    );
    expect(runtimeMocks.disconnectSavedEnvironment).toHaveBeenCalledWith(environmentId);
  });

  it("allows cancelling and confirming removal while an unreachable environment retries", async () => {
    const environmentId = EnvironmentId.make("env-unreachable");
    const connectedAt = "2026-10-25T00:00:00.000Z";
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Unreachable server",
      httpBaseUrl: "https://unreachable.example/",
      wsBaseUrl: "wss://unreachable.example/",
      createdAt: connectedAt,
      lastConnectedAt: connectedAt,
    });
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "disconnected",
      connectedAt,
      reconnectPhase: "waiting",
    });
    await fixture.mount();

    const editButton = page.getByRole("button", { name: "Edit Unreachable server" });
    await expect.element(page.getByText("Reconnecting", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Reconnect Unreachable server" }))
      .toBeDisabled();
    await expect.element(editButton).toBeEnabled();
    await fixture.native(() => editButton.click());
    await fixture.native(() =>
      page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
    );
    await fixture.native(() =>
      page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click(),
    );
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(runtimeMocks.removeSavedEnvironment).not.toHaveBeenCalled();

    await fixture.native(() =>
      page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click(),
    );
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connecting",
      reconnectPhase: "attempting",
    });
    await fixture.native(() =>
      page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click(),
    );

    expect(runtimeMocks.removeSavedEnvironment).toHaveBeenCalledExactlyOnceWith(environmentId);
    expect(runtimeMocks.reconnectSavedEnvironment).not.toHaveBeenCalled();
    expect(runtimeMocks.disconnectSavedEnvironment).not.toHaveBeenCalled();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("edits an unreachable environment and locks pending saves until local persistence completes", async () => {
    const environmentId = EnvironmentId.make("offline-edit");
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Offline box",
      httpBaseUrl: "http://10.0.0.108:3774/",
      wsBaseUrl: "ws://10.0.0.108:3774/",
      createdAt: "2026-10-25T00:00:00.000Z",
      lastConnectedAt: null,
    });
    useSavedEnvironmentRuntimeStore
      .getState()
      .patch(environmentId, { connectionState: "connecting", reconnectPhase: "attempting" });
    let finish!: () => void;
    runtimeMocks.updateSavedEnvironment.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    fixture.afterUnmount(() => finish());
    try {
      await fixture.mount();
      await fixture.native(() => page.getByRole("button", { name: "Edit Offline box" }).click());
      const dialog = page.getByRole("dialog");
      await expect
        .element(dialog.getByLabelText("Name", { exact: true }))
        .toHaveValue("Offline box");
      await expect
        .element(dialog.getByLabelText("IP address or hostname"))
        .toHaveValue("10.0.0.108");
      await expect.element(dialog.getByLabelText("Port", { exact: true })).toHaveValue(3774);
      await fixture.native(() => dialog.getByLabelText("Name", { exact: true }).fill("New box"));
      await fixture.native(() =>
        dialog.getByLabelText("IP address or hostname").fill("10.0.0.109"),
      );
      await fixture.native(() => dialog.getByLabelText("Port", { exact: true }).fill("3775"));
      await fixture.native(() => dialog.getByRole("button", { name: "Save", exact: true }).click());
      expect(runtimeMocks.updateSavedEnvironment).toHaveBeenCalledExactlyOnceWith(environmentId, {
        label: "New box",
        host: "10.0.0.109",
        port: "3775",
      });
      await expect
        .element(dialog.getByRole("button", { name: "Save", exact: true }))
        .toBeDisabled();
      await expect
        .element(dialog.getByRole("button", { name: "Delete", exact: true }))
        .toBeDisabled();
      finish();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(runtimeMocks.removeSavedEnvironment).not.toHaveBeenCalled();
      expect(runtimeMocks.reconnectSavedEnvironment).not.toHaveBeenCalled();
    } finally {
      finish();
    }
  });

  it("discards cancelled edits and shows sanitized save failures without losing the form", async () => {
    const environmentId = EnvironmentId.make("edit-failure");
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId,
      label: "Box",
      httpBaseUrl: "https://box.example/",
      wsBaseUrl: "wss://box.example/",
      createdAt: "2026-10-25T00:00:00.000Z",
      lastConnectedAt: null,
    });
    await fixture.mount();
    await fixture.native(() => page.getByRole("button", { name: "Edit Box", exact: true }).click());
    let dialog = page.getByRole("dialog");
    await fixture.native(() => dialog.getByLabelText("Name", { exact: true }).fill("Discard me"));
    await fixture.native(() => dialog.getByRole("button", { name: "Cancel", exact: true }).click());
    await expect.element(dialog).not.toBeInTheDocument();
    await fixture.native(() => page.getByRole("button", { name: "Edit Box", exact: true }).click());
    dialog = page.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Name", { exact: true })).toHaveValue("Box");
    await expect.element(dialog.getByLabelText("Port", { exact: true })).toHaveValue(443);
    runtimeMocks.updateSavedEnvironment.mockRejectedValueOnce(new Error("secret storage payload"));
    await fixture.native(() => dialog.getByRole("button", { name: "Save", exact: true }).click());
    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("Could not save this environment. Try again.");
    expect(document.body.textContent).not.toContain("secret storage payload");
    await expect.element(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });

  it("reorders saved environments with native pointer dragging and keyboard controls", async () => {
    const ids = ["first", "second", "third"].map((id) => EnvironmentId.make(id));
    for (const [index, environmentId] of ids.entries()) {
      useSavedEnvironmentRegistryStore.getState().upsert({
        environmentId,
        label: ["Zulu", "Alpha", "Middle"][index]!,
        httpBaseUrl: `https://${environmentId}.example/`,
        wsBaseUrl: `wss://${environmentId}.example/`,
        createdAt: "2026-10-25T00:00:00.000Z",
        lastConnectedAt: null,
      });
    }
    await fixture.mount();
    const order = () =>
      Array.from(
        document.querySelectorAll(
          '[aria-label="Saved environment order"] [aria-roledescription="sortable"]',
        ),
      ).map((element) => element.getAttribute("aria-label"));
    expect(order()).toEqual(["Reorder Zulu", "Reorder Alpha", "Reorder Middle"]);
    await fixture.drag(
      page.getByRole("button", { name: "Reorder Zulu", exact: true }).element() as HTMLElement,
      page.getByRole("button", { name: "Reorder Middle", exact: true }).element() as HTMLElement,
    );
    await vi.waitFor(() =>
      expect(order()).toEqual(["Reorder Alpha", "Reorder Middle", "Reorder Zulu"]),
    );
    expect(Object.keys(useSavedEnvironmentRegistryStore.getState().byId)).toEqual([
      ids[1],
      ids[2],
      ids[0],
    ]);
    const handle = page.getByRole("button", { name: "Reorder Zulu", exact: true });
    await fixture.native(() => handle.click());
    await expect.element(handle).toHaveFocus();
    await fixture.native(() => userEvent.keyboard("[Space]"));
    await fixture.native(() => userEvent.keyboard("[ArrowUp]"));
    await fixture.native(() => userEvent.keyboard("[Space]"));
    await vi.waitFor(() =>
      expect(order()).toEqual(["Reorder Alpha", "Reorder Zulu", "Reorder Middle"]),
    );
    expect(Object.keys(useSavedEnvironmentRegistryStore.getState().byId)).toEqual([
      ids[1],
      ids[0],
      ids[2],
    ]);
    expect(runtimeMocks.updateSavedEnvironment).not.toHaveBeenCalled();
    expect(runtimeMocks.removeSavedEnvironment).not.toHaveBeenCalled();
  });
});
