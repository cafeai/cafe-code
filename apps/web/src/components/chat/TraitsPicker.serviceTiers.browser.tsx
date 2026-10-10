import {
  ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@cafecode/contracts";
import "../../index.css";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TraitsPicker } from "./TraitsPicker";

const models: ServerProviderModel[] = [
  {
    slug: "sol",
    name: "Sol",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service tier",
          type: "select",
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultra fast" },
          ],
        },
      ],
    },
  },
];
async function mount(options?: readonly ProviderOptionSelection[]) {
  const onModelOptionsChange = vi.fn();
  const screen = await render(
    <TraitsPicker
      provider={ProviderDriverKind.make("codex")}
      models={models}
      model="sol"
      prompt=""
      onPromptChange={vi.fn()}
      modelOptions={options}
      onModelOptionsChange={onModelOptionsChange}
    />,
  );
  return { screen, onModelOptionsChange };
}
describe("advertised Codex service tier selector", () => {
  it("does not choose a paid tier on mount and preserves the exact selected id", async () => {
    const { screen, onModelOptionsChange } = await mount();
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    await screen.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Ultra fast", exact: true }).click();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "serviceTier", value: "ultrafast" },
    ]);
  });

  it("shows legacy Fast as its same tier and permits explicit Standard", async () => {
    const { screen, onModelOptionsChange } = await mount([{ id: "fastMode", value: true }]);
    await expect.element(screen.getByRole("button")).toHaveTextContent("Fast");
    await screen.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Standard", exact: true }).click();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("keeps a removed tier visibly unavailable until the user changes it", async () => {
    const { screen, onModelOptionsChange } = await mount([
      { id: "serviceTier", value: "removed-tier" },
    ]);
    await expect.element(screen.getByRole("button")).toHaveTextContent("Unavailable service tier");
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    await screen.getByRole("button").click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(
        "This saved tier is unavailable. Choose an available tier before sending.",
      );
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    await page.getByRole("menuitemradio", { name: "Fast", exact: true }).click();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "serviceTier", value: "priority" },
    ]);
  });
});

describe("advertised native Claude Ultracode selector", () => {
  const claudeModels: ServerProviderModel[] = [
    {
      slug: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            currentValue: "max",
            options: [{ id: "max", label: "Max", isDefault: true }],
          },
          {
            id: "ultracode",
            label: "Ultracode",
            type: "boolean",
            description:
              "Native workflow orchestration. May use substantially more tokens and agents; native eligibility and tool approvals apply.",
          },
        ],
      },
    },
  ];
  async function mountClaude(options?: readonly ProviderOptionSelection[]) {
    const onModelOptionsChange = vi.fn();
    const onPromptChange = vi.fn();
    const screen = await render(
      <TraitsPicker
        provider={ProviderDriverKind.make("claudeAgent")}
        models={claudeModels}
        model="claude-opus-5-5"
        prompt=""
        onPromptChange={onPromptChange}
        modelOptions={options}
        onModelOptionsChange={onModelOptionsChange}
      />,
    );
    return { screen, onModelOptionsChange, onPromptChange };
  }
  it("shows the usage caution and preserves Max when requesting Ultracode", async () => {
    const { screen, onModelOptionsChange, onPromptChange } = await mountClaude();
    await expect.element(screen.getByRole("button")).toHaveTextContent("Max");
    expect(onModelOptionsChange).not.toHaveBeenCalled();
    await screen.getByRole("button").click();
    await expect
      .element(
        page.getByText(
          "Native workflow orchestration. May use substantially more tokens and agents; native eligibility and tool approvals apply.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Native default", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "On", exact: true }).click();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "max" },
      { id: "ultracode", value: true },
    ]);
    expect(onPromptChange).not.toHaveBeenCalled();
  });
  it("permits explicit Off without changing effort or prompt", async () => {
    const { screen, onModelOptionsChange, onPromptChange } = await mountClaude([
      { id: "ultracode", value: true },
    ]);
    await expect.element(screen.getByRole("button")).toHaveTextContent("Max · Ultracode");
    await screen.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith([
      { id: "effort", value: "max" },
      { id: "ultracode", value: false },
    ]);
    expect(onPromptChange).not.toHaveBeenCalled();
  });
  it("clears a previous request when choosing Native default", async () => {
    const { screen, onModelOptionsChange, onPromptChange } = await mountClaude([
      { id: "ultracode", value: true },
    ]);
    await screen.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Native default", exact: true }).click();
    expect(onModelOptionsChange).toHaveBeenLastCalledWith([{ id: "effort", value: "max" }]);
    expect(onPromptChange).not.toHaveBeenCalled();
  });
});
