import "../../index.css";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TooltipProvider } from "../ui/tooltip";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";

const instanceId = ProviderInstanceId.make("codex-personal");
const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("codex"),
  displayName: "Personal Codex",
  enabled: true,
  config: {},
  environment: [],
};

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

async function mountCard(auth: ServerProvider["auth"]) {
  const provider: ServerProvider = {
    instanceId,
    driver: instance.driver,
    enabled: true,
    installed: true,
    version: "0.163.0",
    status: "ready",
    auth,
    checkedAt: "2026-09-17T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const onUpdate = vi.fn<(next: ProviderInstanceConfig) => void>();
  mounted = await render(
    <TooltipProvider>
      <ProviderInstanceCard
        instanceId={instanceId}
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

describe("Codex subscription labels in provider settings", () => {
  // The server owns tier interpretation. Both card layouts must retain its
  // label, including the email layout, which does not render summary.headline.
  it.each([
    "ChatGPT Plus Subscription",
    "ChatGPT Pro 5x Subscription",
    "ChatGPT Pro 20x Subscription",
  ])("shows %s without requiring an account email", async (label) => {
    const onUpdate = await mountCard({ status: "authenticated", type: "chatgpt", label });
    await expect.element(page.getByText(`Authenticated · ${label}`, { exact: true })).toBeVisible();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each([
    "ChatGPT Plus Subscription",
    "ChatGPT Pro 5x Subscription",
    "ChatGPT Pro 20x Subscription",
  ])("shows %s beside a still-redacted account email", async (label) => {
    const onUpdate = await mountCard({
      status: "authenticated",
      type: "chatgpt",
      label,
      email: "account@example.invalid",
    });
    await expect.element(page.getByText("Authenticated as", { exact: true })).toBeVisible();
    await expect.element(page.getByText(`· ${label}`, { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Toggle account email visibility" }))
      .toBeVisible();
    await expect
      .element(page.getByText("account@example.invalid", { exact: true }))
      .not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { type: "chatgpt", label: "ChatGPT Subscription" },
    { type: "apiKey", label: "API Key" },
  ])("does not invent a subscription tier for $label", async ({ type, label }) => {
    await mountCard({ status: "authenticated", type, label });
    await expect.element(page.getByText(`Authenticated · ${label}`, { exact: true })).toBeVisible();
    await expect.element(page.getByText(/ChatGPT Pro (5x|20x)/)).not.toBeInTheDocument();
  });
});
