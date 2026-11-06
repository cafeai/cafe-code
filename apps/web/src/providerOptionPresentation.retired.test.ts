import type { ProviderOptionDescriptor } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { withoutRetiredProviderOptions } from "./providerOptionPresentation";

describe("withoutRetiredProviderOptions", () => {
  it("drops Claude's output style so it stays at the provider default", () => {
    const descriptors: ProviderOptionDescriptor[] = [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
      {
        id: "outputStyle",
        label: "Output Style",
        type: "select",
        options: [
          { id: "providerDefault", label: "Provider Default", isDefault: true },
          { id: "concise", label: "Concise" },
        ],
        currentValue: "concise",
      },
    ];
    expect(withoutRetiredProviderOptions(descriptors).map((descriptor) => descriptor.id)).toEqual([
      "effort",
    ]);
  });
});
