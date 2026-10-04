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
