import { getSharedHighlighter, type DiffsHighlighter } from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

const MAX_HIGHLIGHTER_PROMISES = 128;
const MAX_LANGUAGE_LABEL_LENGTH = 128;
const highlighterPromises = new Map<string, Promise<DiffsHighlighter>>();

/** A bounded, stable resource identity for React's Suspense/use retries. */
export function getChatCodeHighlighter(language: string): Promise<DiffsHighlighter> {
  if (language.length > MAX_LANGUAGE_LABEL_LENGTH) return getChatCodeHighlighter("text");
  const cached = highlighterPromises.get(language);
  if (cached) return cached;

  // Fence labels are provider-authored. Reserve capacity for plain text and
  // stop admitting labels at the bound rather than evicting a Promise that a
  // mounted Suspense consumer may still be retrying. Saturation loses syntax
  // color for new languages; source and copy behavior remain available.
  if (language !== "text" && highlighterPromises.size >= MAX_HIGHLIGHTER_PROMISES - 1) {
    return getChatCodeHighlighter("text");
  }

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    // Keep this exact Promise cached after failure as well as success. Deleting
    // it here makes React's retry create another pending Promise indefinitely,
    // so an unsupported label never reaches its fallback and a terminal text
    // initialization error never reaches the surrounding error boundary.
    if (language === "text") throw error;
    return getChatCodeHighlighter("text");
  });
  highlighterPromises.set(language, promise);
  return promise;
}
