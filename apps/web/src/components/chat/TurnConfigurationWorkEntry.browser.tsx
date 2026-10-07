import "../../index.css";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderTurnConfiguration,
} from "@cafecode/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TurnConfigurationWorkEntry } from "./TurnConfigurationWorkEntry";

const configuration: ProviderTurnConfiguration = {
  version: 1,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  providerDisplayName: "Codex Personal",
  model: "gpt-6.1-sol",
  modelDisplayName: "GPT-6.1 Sol",
  effort: "ultra",
  fastMode: true,
  runtimeMode: "full-access",
  interactionMode: "default",
  settingsSource: "submitted",
};
const initialFontSize = document.documentElement.style.fontSize;

afterEach(() => {
  document.documentElement.style.fontSize = initialFontSize;
});

describe("turn configuration work-log row", () => {
  it.each([
    ["default", "Fast off", "Standard"],
    ["priority", "Fast on", "Fast"],
    ["ultrafast", "Ultra fast", "Ultra fast"],
  ])(
    "shows inherited native %s routing on one line with the tier in its tooltip",
    async (tier, fast, label) => {
      const { fastMode: _fast, ...inherited } = configuration;
      const view = await render(
        <TurnConfigurationWorkEntry configuration={{ ...inherited, resolvedServiceTier: tier }} />,
      );
      try {
        const settings = document.querySelector<HTMLElement>("[data-turn-configuration-settings]")!;
        expect(settings.textContent).toBe(
          `GPT-6.1 Sol · Ultra · ${fast} · Codex Personal · Build · Full access`,
        );
        expect(settings.textContent).not.toContain("Default");
        settings.focus();
        await expect
          .element(page.getByText(new RegExp(`Submitted settings · Service tier: ${label}\\.`)))
          .toBeVisible();
      } finally {
        await view.unmount();
      }
    },
  );

  it.each([
    { width: 240, scale: 80, longLabels: false },
    { width: 240, scale: 130, longLabels: false },
    { width: 320, scale: 100, longLabels: false },
    { width: 280, scale: 130, longLabels: true },
    { width: 480, scale: 100, longLabels: true },
  ])(
    "keeps settings and the account label visible without overflow at $width px / $scale%",
    async (options) => {
      document.documentElement.style.fontSize = `${options.scale}%`;
      const snapshot = {
        ...configuration,
        ...(options.longLabels
          ? {
              providerDisplayName: `Account-${"a".repeat(170)}`,
              modelDisplayName: `Model-${"m".repeat(170)}`,
            }
          : {}),
      };
      const view = await render(
        <div data-testid="turn-settings-pane" style={{ width: options.width }}>
          <TurnConfigurationWorkEntry configuration={snapshot} />
        </div>,
      );
      try {
        const pane = document.querySelector<HTMLElement>("[data-testid='turn-settings-pane']")!;
        const row = pane.querySelector<HTMLElement>("[data-turn-configuration-row]")!;
        const settings = row.querySelector<HTMLElement>("[data-turn-configuration-settings]")!;
        await expect.element(settings).toBeVisible();
        expect(settings.textContent).toBe(
          `${snapshot.modelDisplayName} · Ultra · Fast on · ${snapshot.providerDisplayName} · Build · Full access`,
        );
        expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
        expect(settings.scrollWidth).toBeLessThanOrEqual(settings.clientWidth + 1);
        expect(settings.className).not.toContain("truncate");
        if (options.longLabels) {
          expect(settings.getBoundingClientRect().height).toBeGreaterThan(40);
        }
      } finally {
        await view.unmount();
      }
    },
  );

  it("names a Claude turn by its single native permission mode", async () => {
    const view = await render(
      <TurnConfigurationWorkEntry
        configuration={{
          ...configuration,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claude_work"),
          providerDisplayName: "Claude Work",
          modelDisplayName: "Opus 5.5",
          effort: "max",
          interactionMode: "default",
          runtimeMode: "approval-required",
        }}
      />,
    );
    try {
      const settings = document.querySelector<HTMLElement>("[data-turn-configuration-settings]")!;
      await expect.element(settings).toBeVisible();
      expect(settings.textContent).toBe("Opus 5.5 · Max · Fast on · Claude Work · Ask permissions");
      expect(settings.textContent).not.toContain("Build");
      expect(settings.textContent).not.toContain("Supervised");
    } finally {
      await view.unmount();
    }
  });

  it("renders configured labels as inert plain text, not active markup or links", async () => {
    const view = await render(
      <TurnConfigurationWorkEntry
        configuration={{
          ...configuration,
          modelDisplayName: '<img src=x onerror="alert(1)">',
          providerDisplayName: "[work account](javascript:alert(1))",
        }}
      />,
    );
    try {
      await expect.element(page.getByText('<img src=x onerror="alert(1)">')).toBeVisible();
      await expect.element(page.getByText("[work account](javascript:alert(1))")).toBeVisible();
      const row = document.querySelector<HTMLElement>("[data-turn-configuration-row]")!;
      expect(row.querySelectorAll("a,img,script,iframe,input,button")).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });
});
