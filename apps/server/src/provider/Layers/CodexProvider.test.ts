import { describe, expect, it } from "vitest";

import { parseCodexModelListResponse } from "./CodexProvider.ts";

describe("parseCodexModelListResponse", () => {
  it("preserves Codex model specialty metadata for provider safety policy", () => {
    const models = parseCodexModelListResponse({
      data: [
        {
          defaultReasoningEffort: "high",
          description: "Security-specialized model",
          displayName: "Security Model",
          hidden: false,
          id: "security-model",
          isDefault: false,
          model: "security-model",
          modelSpecialty: "cyber",
          supportedReasoningEfforts: [
            {
              description: "Thorough reasoning",
              reasoningEffort: "high",
            },
          ],
        },
      ],
      nextCursor: null,
    });

    expect(models).toHaveLength(1);
    expect(models[0]?.modelSpecialty).toBe("cyber");
  });
});
