import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  ProviderInstanceId,
  type AdvertisedEndpoint,
  type AuthAccessStreamEvent,
  type DesktopBridge,
} from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText, type UiLocale } from "@cafecode/shared/i18n";
import { useUiStateStore } from "../../uiStateStore";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { ProviderModelsSection } from "./ProviderModelsSection";

const harness = vi.hoisted(() => ({
  passwordStatus: vi.fn(async () => ({ configured: false })),
  setPassword: vi.fn(async () => ({ configured: true })),
  clearPassword: vi.fn(async () => ({ configured: false })),
  createPairing: vi.fn(),
  revokeOtherClients: vi.fn(),
  revokeClient: vi.fn(),
  revokePairing: vi.fn(),
  subscribeAccess: vi.fn((listener: (event: AuthAccessStreamEvent) => void) => {
    listener({
      version: 1,
      revision: 1,
      type: "snapshot",
      payload: { pairingLinks: [], clientSessions: [] },
    });
    return () => {};
  }),
}));

// Only synthetic auth/desktop interfaces are admitted. This fixture never
// talks to a Cafe server, writes credentials, or reads an ambient provider.
vi.mock("~/environments/workspace", () => ({ useWorkspaceEnvironmentId: () => "feedback-local" }));
vi.mock("~/environments/primary", () => ({
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: "feedback-local" }),
  isLoopbackHostname: (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1",
}));
vi.mock("~/environments/workspaceAuth", () => ({
  createWorkspaceAuthApi: () => ({
    fetchServerAdminPasswordStatus: harness.passwordStatus,
    setServerAdminPassword: harness.setPassword,
    clearServerAdminPassword: harness.clearPassword,
    createServerPairingCredential: harness.createPairing,
    revokeOtherServerClientSessions: harness.revokeOtherClients,
    revokeServerClientSession: harness.revokeClient,
    revokeServerPairingLink: harness.revokePairing,
  }),
}));
vi.mock("~/environments/runtime", () => {
  const connection = { client: { server: { subscribeAuthAccess: harness.subscribeAccess } } };
  return {
    getEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773/",
    getPrimaryEnvironmentConnection: () => connection,
    readEnvironmentConnection: () => connection,
  };
});
vi.mock("~/rpc/serverState", () => ({ useServerConfig: () => null }));
vi.mock("./SavedEnvironmentsSettings", () => ({ SavedEnvironmentsSettings: () => null }));
// Enrollment has separate browser coverage. Keep this password/endpoint fixture
// inside its synthetic auth boundary without importing the live factor API.
vi.mock("./TwoFactorManagementRow", () => ({ TwoFactorManagementRow: () => null }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

const originalLocale = getUiLocale();
const originalBridge = window.desktopBridge;
let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  setUiLocale("en");
  vi.clearAllMocks();
  harness.passwordStatus.mockResolvedValue({ configured: false });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  if (originalBridge) window.desktopBridge = originalBridge;
  else Reflect.deleteProperty(window, "desktopBridge");
  setUiLocale(originalLocale);
});

function connectionBridge() {
  const getExposure = vi.fn(async () => ({
    mode: "local-only",
    httpsEnabled: false,
    endpointUrl: "http://127.0.0.1:3773/",
    advertisedHost: "127.0.0.1",
  }));
  const getEndpoints = vi.fn(async (): Promise<readonly AdvertisedEndpoint[]> => []);
  window.desktopBridge = {
    getServerExposureState: getExposure,
    getAdvertisedEndpoints: getEndpoints,
  } as unknown as DesktopBridge;
  return { getExposure, getEndpoints };
}

const endpointHttpUrls = ["http://127.0.0.1:3773/", "http://192.0.2.10:3773/"] as const;
function endpointSnapshot(locale: UiLocale): readonly AdvertisedEndpoint[] {
  return endpointHttpUrls.map((url, index): AdvertisedEndpoint => ({
    id: `${index === 0 ? "desktop-loopback" : "desktop-lan"}:${url}`,
    label:
      index === 0
        ? uiText("This machine", undefined, undefined, locale)
        : uiText("Local network", undefined, undefined, locale),
    provider: { id: "desktop-core", label: "Cafe desktop", kind: "core", isAddon: false },
    httpBaseUrl: url,
    wsBaseUrl: url.replace(/^http:/u, "ws:"),
    reachability: index === 0 ? "loopback" : "lan",
    source: "desktop-core",
    status: "available",
    isDefault: index === 1,
  }));
}

function deferredEndpoints() {
  let resolve!: (value: readonly AdvertisedEndpoint[]) => void;
  const promise = new Promise<readonly AdvertisedEndpoint[]>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function endpointLocaleBridge() {
  const reads = connectionBridge();
  reads.getExposure.mockResolvedValue({
    mode: "network-accessible",
    httpsEnabled: false,
    endpointUrl: endpointHttpUrls[1],
    advertisedHost: "192.0.2.10",
  });
  reads.getEndpoints.mockResolvedValue(endpointSnapshot("en"));
  const listeners = new Set<(locale: UiLocale) => void>();
  const unsubscribe = vi.fn();
  const onUiLocaleChanged = vi.fn((listener: (locale: UiLocale) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      unsubscribe();
    };
  });
  const setExposure = vi.fn();
  const setHttps = vi.fn();
  window.desktopBridge = {
    ...window.desktopBridge!,
    onUiLocaleChanged,
    setServerExposureMode: setExposure,
    setServerHttpsEnabled: setHttps,
  } as unknown as DesktopBridge;
  return {
    ...reads,
    onUiLocaleChanged,
    unsubscribe,
    setExposure,
    setHttps,
    emitMainLocale: (locale: UiLocale) => {
      for (const listener of listeners) listener(locale);
    },
  };
}

function expectOnlyMetadataReads(bridge: ReturnType<typeof endpointLocaleBridge>, count: number) {
  expect(bridge.getEndpoints).toHaveBeenCalledTimes(count);
  expect(bridge.getExposure).toHaveBeenCalledTimes(1);
  expect(harness.passwordStatus).toHaveBeenCalledTimes(1);
  expect(harness.subscribeAccess).toHaveBeenCalledTimes(1);
  for (const action of [
    bridge.setExposure,
    bridge.setHttps,
    harness.setPassword,
    harness.clearPassword,
    harness.createPairing,
    harness.revokeOtherClients,
    harness.revokeClient,
    harness.revokePairing,
  ])
    expect(action).not.toHaveBeenCalled();
}

it("refreshes native endpoint labels only after admitted main language events without replaying auth", async () => {
  const previousPreference = useUiStateStore.getState().defaultAdvertisedEndpointKey;
  useUiStateStore.setState({ defaultAdvertisedEndpointKey: "desktop-core:lan:http" });
  const bridge = endpointLocaleBridge();
  mounted = await render(<ConnectionsSettings />);
  try {
    await expect
      .element(page.getByRole("heading", { name: "This machine", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .toBeVisible();
    const originalRows = ["This machine", "Local network"].map((name) =>
      page.getByRole("heading", { name, exact: true }).element(),
    );
    expectOnlyMetadataReads(bridge, 1);
    expect(bridge.onUiLocaleChanged).toHaveBeenCalledTimes(1);
    for (const [locale, count] of [
      ["ja", 2],
      ["ko", 3],
    ] as const) {
      // An optimistic renderer repaint alone must not race the main-owned
      // metadata language. Only the synthetic admitted main event rereads it.
      setUiLocale(locale);
      await expect
        .element(
          page.getByRole("heading", {
            name: uiText("Local server", undefined, undefined, locale),
            exact: true,
          }),
        )
        .toBeVisible();
      expectOnlyMetadataReads(bridge, count - 1);
      bridge.getEndpoints.mockResolvedValue(endpointSnapshot(locale));
      bridge.emitMainLocale(locale);
      for (const [index, source] of ["This machine", "Local network"].entries()) {
        const heading = page.getByRole("heading", {
          name: uiText(source, undefined, undefined, locale),
          exact: true,
        });
        await expect.element(heading).toBeVisible();
        // Stable canonical endpoint IDs keep the same row nodes and URLs;
        // translated labels cannot become selection or reconciliation keys.
        expect(heading.element()).toBe(originalRows[index]);
        expect(heading.element().parentElement?.querySelector("p")?.textContent).toBe(
          endpointHttpUrls[index],
        );
      }
      const lanRow = originalRows[1]!.parentElement!.parentElement!;
      expect(lanRow.textContent).toContain(uiText("Default", undefined, undefined, locale));
      expect(useUiStateStore.getState().defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
      expectOnlyMetadataReads(bridge, count);
    }
    expect(bridge.unsubscribe).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
    mounted = undefined;
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: previousPreference });
  }
  expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  bridge.emitMainLocale("en");
  expectOnlyMetadataReads(bridge, 3);
});

it("rejects late endpoint-language responses and releases the main-event subscription on unmount", async () => {
  const bridge = endpointLocaleBridge();
  mounted = await render(<ConnectionsSettings />);
  await expect
    .element(page.getByRole("heading", { name: "Local network", exact: true }))
    .toBeVisible();
  const lateJapanese = deferredEndpoints();
  bridge.getEndpoints.mockReturnValueOnce(lateJapanese.promise);
  setUiLocale("ja");
  bridge.emitMainLocale("ja");
  bridge.getEndpoints.mockResolvedValue(endpointSnapshot("ko"));
  setUiLocale("ko");
  bridge.emitMainLocale("ko");
  await expect
    .element(page.getByRole("heading", { name: "로컬 네트워크", exact: true }))
    .toBeVisible();
  lateJapanese.resolve(endpointSnapshot("ja"));
  await lateJapanese.promise;
  await mounted.rerender(<ConnectionsSettings />);
  await expect
    .element(page.getByRole("heading", { name: "로컬 네트워크", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "ローカルネットワーク", exact: true }))
    .not.toBeInTheDocument();
  expectOnlyMetadataReads(bridge, 3);
  const lateUnmount = deferredEndpoints();
  bridge.getEndpoints.mockReturnValueOnce(lateUnmount.promise);
  bridge.emitMainLocale("en");
  expectOnlyMetadataReads(bridge, 4);
  await mounted.unmount();
  mounted = undefined;
  expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  lateUnmount.resolve(endpointSnapshot("en"));
  await lateUnmount.promise;
  bridge.emitMainLocale("ja");
  expectOnlyMetadataReads(bridge, 4);
});

it("retranslates model validation without replacing canonical slugs or saving a duplicate", async () => {
  const onChange = vi.fn();
  mounted = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("feedback-model-owner")}
      driverKind={null}
      models={[
        { slug: "exact-model", name: "Received model name", isCustom: false, capabilities: null },
      ]}
      customModels={[]}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={onChange}
      onHiddenModelsChange={vi.fn()}
      onFavoriteModelsChange={vi.fn()}
      onModelOrderChange={vi.fn()}
    />,
  );
  await page.getByRole("textbox").fill("exact-model");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect
    .element(page.getByText("That model is already built in.", { exact: true }))
    .toBeVisible();
  setUiLocale("ko");
  await expect
    .element(page.getByText("해당 모델은 이미 내장되어 있습니다.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("textbox")).toHaveValue("exact-model");
  await expect.element(page.getByText("Received model name", { exact: true })).toBeVisible();
  expect(onChange).not.toHaveBeenCalled();
});

it.each([false, true])(
  "uses a complete translated favorite action while preserving the received model when selected=%s",
  async (favorite) => {
    const onFavoriteModelsChange = vi.fn();
    const model = "Received model name";
    mounted = await render(
      <ProviderModelsSection
        instanceId={ProviderInstanceId.make("feedback-favorite-owner")}
        driverKind={null}
        models={[{ slug: "exact-model", name: model, isCustom: false, capabilities: null }]}
        customModels={[]}
        hiddenModels={[]}
        favoriteModels={favorite ? ["exact-model"] : []}
        modelOrder={[]}
        onChange={vi.fn()}
        onHiddenModelsChange={vi.fn()}
        onFavoriteModelsChange={onFavoriteModelsChange}
        onModelOrderChange={vi.fn()}
      />,
    );
    await expect
      .element(
        page.getByRole("button", {
          name: favorite ? `Remove ${model} from favorites` : `Add ${model} to favorites`,
          exact: true,
        }),
      )
      .toBeVisible();
    setUiLocale("ko");
    const action = page.getByRole("button", {
      name: favorite ? `${model} 즐겨찾기에서 제거` : `${model} 즐겨찾기에 추가`,
      exact: true,
    });
    await expect.element(action).toBeVisible();
    expect(onFavoriteModelsChange).not.toHaveBeenCalled();
    await action.click();
    expect(onFavoriteModelsChange).toHaveBeenCalledExactlyOnceWith(favorite ? [] : ["exact-model"]);
  },
);

it("retranslates password validation without clearing drafts or invoking authentication changes", async () => {
  const { getExposure, getEndpoints } = connectionBridge();
  mounted = await render(<ConnectionsSettings />);
  const toggle = page.getByRole("switch", { name: "Enable password authentication" });
  await expect.element(toggle).toBeEnabled();
  await toggle.click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("textbox", { name: "Admin password", exact: true }).fill("short");
  await page.getByRole("textbox", { name: "Confirm password", exact: true }).fill("short");
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect
    .element(page.getByText("Admin password must be at least 8 characters.", { exact: true }))
    .toBeVisible();
  setUiLocale("ko");
  await expect
    .element(page.getByText("관리자 비밀번호는 8자 이상이어야 합니다.", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByRole("textbox", {
        name: uiText("Admin password", undefined, undefined, "ko"),
        exact: true,
      }),
    )
    .toHaveValue("short");
  expect(harness.setPassword).not.toHaveBeenCalled();
  expect(harness.clearPassword).not.toHaveBeenCalled();
  expect(harness.passwordStatus).toHaveBeenCalledTimes(1);
  expect(harness.subscribeAccess).toHaveBeenCalledTimes(1);
  expect(getExposure).toHaveBeenCalledTimes(1);
  expect(getEndpoints).toHaveBeenCalledTimes(1);
});

it.each(["source", "received"] as const)(
  "preserves %s provenance for retained network-state errors without another desktop read",
  async (origin) => {
    const { getExposure, getEndpoints } = connectionBridge();
    const source = "Failed to load network exposure state.";
    getExposure.mockRejectedValueOnce(origin === "received" ? new Error(source) : undefined);
    mounted = await render(<ConnectionsSettings />);
    await expect.element(page.getByText(source, { exact: true })).toBeVisible();
    setUiLocale("ko");
    await expect
      .element(
        page.getByRole("heading", {
          name: uiText("Local server", undefined, undefined, "ko"),
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          origin === "received" ? source : "네트워크 공개 상태를 불러오지 못했습니다.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(harness.passwordStatus).toHaveBeenCalledTimes(1);
    expect(harness.subscribeAccess).toHaveBeenCalledTimes(1);
    expect(getExposure).toHaveBeenCalledTimes(1);
    expect(getEndpoints).toHaveBeenCalledTimes(1);
  },
);
