import { TextGenerationError } from "@cafecode/contracts";
import * as Effect from "effect/Effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Gemini text generation helpers are not implemented in the v0 provider. Select Codex or Claude for commit, PR, branch, or title generation.",
    }),
  );

export const makeGeminiTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
