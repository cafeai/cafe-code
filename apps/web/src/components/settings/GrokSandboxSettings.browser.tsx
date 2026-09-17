import "../../index.css";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@cafecode/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TooltipProvider } from "../ui/tooltip";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";

const instanceId = ProviderInstanceId.make("grok-personal");
const baseInstance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("grok"),
  displayName: "Personal Grok",
  enabled: true,
  accentColor: "#2563eb",
  config: {
    binaryPath: "/test/grok",
    homePath: "/test/grok-home",
    customModels: ["custom-model"],
    extensionSetting: { keep: true },
  },
  environment: [{ name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
  defaultModel: "grok-4.6",
  defaultModelOptions: [{ id: "reasoning_effort", value: "high" }],
};

function makeProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
    installed: true,
    version: "1.0.34",
    status: "error",
    auth: { status: "authenticated", email: "test@example.invalid" },
    checkedAt: "2026-09-17T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    sandbox: { status: "unavailable", reason: "container-socket-symlink" },
    ...overrides,
  };
}

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountCard(
  instance: ProviderInstanceConfig = baseInstance,
  provider: ServerProvider = makeProvider(),
) {
  const onUpdate = vi.fn<(next: ProviderInstanceConfig) => void>();
  mounted = await render(
    <TooltipProvider>
      <ProviderInstanceCard
        instanceId={provider.instanceId}
        instance={instance}
        driverOption={DRIVER_OPTION_BY_VALUE[instance.driver]}
        liveProvider={provider}
        isSettingsOpen={false}
        onSettingsOpenChange={vi.fn()}
        isDefaultProvider={false}
        onSetDefaultProvider={vi.fn()}
        onUpdate={onUpdate}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={vi.fn()}
        onFavoriteModelsChange={vi.fn()}
        onModelOrderChange={vi.fn()}
      />
    </TooltipProvider>,
  );
  return onUpdate;
}

describe("Grok sandbox consent in provider settings", () => {
  it("distinguishes sandbox failure and leaves settings untouched on cancellation or dismissal", async () => {
    const onUpdate = await mountCard();
    await expect.element(page.getByText("Sandbox unavailable", { exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText("Grok's sandbox cannot start with a symlinked container-runtime socket."),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Use without sandbox", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Use Grok without sandbox?" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByText(/These checks use Ask permissions and do not submit a chat prompt/))
      .toBeVisible();
    await expect
      .element(dialog.getByText(/Full access also bypasses ordinary approval prompts/))
      .toBeVisible();
    await expect
      .element(
        dialog.getByText(/Plan and protected modes keep their existing sandbox requirements/),
      )
      .toBeVisible();
    await expect.element(dialog.getByText(/may interrupt active sessions/)).toBeVisible();
    expect(onUpdate).not.toHaveBeenCalled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Use without sandbox", exact: true }).click();
    await expect.element(dialog).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("changes only this instance's probe consent after explicit confirmation", async () => {
    const onUpdate = await mountCard();
    await page.getByRole("button", { name: "Use without sandbox", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Use Grok without sandbox?" });
    await dialog.getByRole("button", { name: "Use without sandbox", exact: true }).click();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      ...baseInstance,
      config: { ...(baseInstance.config as Record<string, unknown>), allowUnsandboxedProbe: true },
    });
    await expect.element(dialog).not.toBeInTheDocument();
    expect(baseInstance.config).not.toHaveProperty("allowUnsandboxedProbe");
  });

  it("revokes consent without changing chat defaults or other instance settings", async () => {
    const instance: ProviderInstanceConfig = {
      ...baseInstance,
      config: { ...(baseInstance.config as Record<string, unknown>), allowUnsandboxedProbe: true },
    };
    const onUpdate = await mountCard(
      instance,
      makeProvider({ status: "ready", sandbox: { status: "not-checked" } }),
    );
    await expect.element(page.getByText("Unsandboxed connection checks enabled")).toBeVisible();
    await expect
      .element(page.getByText("Sandbox availability has not been checked."))
      .toBeVisible();
    await page.getByRole("button", { name: "Use protected checks", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Restore protected connection checks?" });
    expect(onUpdate).not.toHaveBeenCalled();
    await dialog.getByRole("button", { name: "Use protected checks", exact: true }).click();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      ...baseInstance,
      config: { ...(baseInstance.config as Record<string, unknown>), allowUnsandboxedProbe: false },
    });
  });

  it("offers explicit opt-in before a sandbox failure and accepts only literal true as consent", async () => {
    const onUpdate = await mountCard(
      { ...baseInstance, config: { allowUnsandboxedProbe: "true" } },
      makeProvider({ status: "ready", sandbox: { status: "available" } }),
    );
    await expect
      .element(page.getByText("Protected connection checks", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("The last protected connection check verified sandbox startup."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Use without sandbox" })).toBeVisible();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not expose Grok consent actions or classify a different provider's sandbox field", async () => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const onUpdate = await mountCard(
      { ...baseInstance, driver, config: { allowUnsandboxedProbe: true } },
      makeProvider({ driver, instanceId: ProviderInstanceId.make("claude-personal") }),
    );
    await expect
      .element(page.getByRole("button", { name: "Use without sandbox" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Use protected checks" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("Sandbox unavailable", { exact: true }))
      .not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
