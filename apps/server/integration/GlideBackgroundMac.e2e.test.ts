import { it } from "vitest";
import { qualifyBackground } from "./fixtures/glide-background-harness.ts";

it.skipIf(process.platform !== "darwin")(
  "restores exact hidden and minimized private windows without foreground, pointer or Space changes",
  () => qualifyBackground(false, false, false, true),
  60_000,
);

it.skipIf(process.platform !== "darwin")(
  "launches an exact stopped private app through Glide and qualifies its background recovery without activation",
  () => qualifyBackground(false, false, true),
  60_000,
);

it.skipIf(process.platform !== "darwin")(
  "controls a background AppKit window while preserving external foreground and pointer",
  () => qualifyBackground(true),
  60_000,
);

it.skipIf(process.platform !== "darwin")(
  "controls background input from AX observations while preserving external foreground and pointer",
  () => qualifyBackground(false),
  60_000,
);
