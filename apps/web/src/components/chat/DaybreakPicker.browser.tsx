import type { ProviderOptionSelection, ServerProviderModel } from "@cafecode/contracts";
import { ProviderDriverKind } from "@cafecode/contracts";
import "../../index.css";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TraitsPicker } from "./TraitsPicker";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function models(program?: "daybreakBlue" | "daybreakRed"): ReadonlyArray<ServerProviderModel> {
  return [
    {
      slug: "account-model",
      name: "Account model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High", isDefault: true }],
          },
          ...(program
            ? [
                {
                  id: "cyberAccessProgram",
                  label: "Daybreak",
                  type: "select" as const,
                  currentValue: "standard",
                  description: `On uses ${program}.`,
                  options: [
                    { id: "standard", label: "Off" },
                    { id: program, label: "On" },
                  ],
                },
              ]
            : []),
        ],
      },
    },
  ];
}

describe("Daybreak model settings", () => {
  it.each(["daybreakBlue", "daybreakRed"] as const)(
    "saves %s On/Off without changing the model and restores the saved choice",
    async (program) => {
      let saved: ReadonlyArray<ProviderOptionSelection> | undefined;
      const onChange = vi.fn((options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
        saved = options;
      });
      const props = {
        provider: ProviderDriverKind.make("codex"),
        model: "account-model",
        models: models(program),
        prompt: "",
        onPromptChange: vi.fn(),
        onModelOptionsChange: onChange,
      };
      const screen = await render(<TraitsPicker {...props} />);
      cleanups.push(() => screen.unmount());
      await page.getByRole("button", { name: "High", exact: true }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Off", exact: true }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("menuitemradio", { name: "On", exact: true }).click();
      expect(saved).toContainEqual({ id: "cyberAccessProgram", value: program });
      expect(onChange).toHaveBeenCalledTimes(1);
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
      await screen.rerender(<TraitsPicker {...props} modelOptions={saved} />);
      await page.getByRole("button", { name: "High · Daybreak", exact: true }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "On", exact: true }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("menuitemradio", { name: "Off", exact: true }).click();
      expect(saved).toContainEqual({ id: "cyberAccessProgram", value: "standard" });
      await screen.rerender(<TraitsPicker {...props} modelOptions={saved} />);
      await expect.element(page.getByRole("button", { name: "High", exact: true })).toBeVisible();
    },
  );

  it("hides Daybreak when switching to an account without advertised access", async () => {
    const props = {
      provider: ProviderDriverKind.make("codex"),
      model: "account-model",
      prompt: "",
      onPromptChange: vi.fn(),
      onModelOptionsChange: vi.fn(),
    };
    const screen = await render(<TraitsPicker {...props} models={models("daybreakBlue")} />);
    cleanups.push(() => screen.unmount());
    await page.getByRole("button", { name: "High", exact: true }).click();
    await expect.element(page.getByText("Daybreak", { exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await screen.rerender(<TraitsPicker {...props} models={models()} />);
    await page.getByRole("button", { name: "High", exact: true }).click();
    await expect.element(page.getByText("Daybreak", { exact: true })).not.toBeInTheDocument();
    expect(props.onModelOptionsChange).not.toHaveBeenCalled();
  });

  it("keeps a saved On choice checked when the selected model changes program", async () => {
    const onChange = vi.fn();
    const props = {
      provider: ProviderDriverKind.make("codex"),
      model: "account-model",
      prompt: "",
      onPromptChange: vi.fn(),
      onModelOptionsChange: onChange,
    };
    const screen = await render(
      <TraitsPicker
        {...props}
        models={models("daybreakBlue")}
        modelOptions={[{ id: "cyberAccessProgram", value: "daybreakRed" }]}
      />,
    );
    cleanups.push(() => screen.unmount());
    await page.getByRole("button", { name: "High · Daybreak", exact: true }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "On", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await screen.rerender(
      <TraitsPicker
        {...props}
        models={models("daybreakRed")}
        modelOptions={[{ id: "cyberAccessProgram", value: "daybreakBlue" }]}
      />,
    );
    await page.getByRole("button", { name: "High · Daybreak", exact: true }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "On", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets a saved On choice be explicitly turned off after access disappears without offering On", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <TraitsPicker
        provider={ProviderDriverKind.make("codex")}
        model="account-model"
        models={[
          { slug: "account-model", name: "Account model", isCustom: false, capabilities: {} },
        ]}
        prompt=""
        onPromptChange={vi.fn()}
        onModelOptionsChange={onChange}
        modelOptions={[{ id: "cyberAccessProgram", value: "daybreakRed" }]}
      />,
    );
    cleanups.push(() => screen.unmount());
    await page.getByRole("button", { name: "Model settings", exact: true }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "On", exact: true }))
      .not.toBeInTheDocument();
    await page
      .getByRole("menuitem", { name: "Turn unavailable Daybreak off", exact: true })
      .click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith([
      { id: "cyberAccessProgram", value: "standard" },
    ]);
  });
});
