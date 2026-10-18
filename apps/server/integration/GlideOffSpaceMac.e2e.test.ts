import { it } from "vitest";
import { qualifyBackground } from "./fixtures/glide-background-harness.ts";

// Explicit setup: an existing inactive ordinary Space is required. No desktop
// is created/switched, and fullscreen Spaces are never used as fixture targets.
it.skipIf(process.platform !== "darwin")(
  "captures and controls an owned off-Space window without changing the active desktop",
  () => qualifyBackground(true, true),
  60_000,
);
