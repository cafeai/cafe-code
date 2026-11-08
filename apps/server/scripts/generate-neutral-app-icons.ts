// Checked-in public fallback artwork only; this never reads a user profile.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderNeutralAppIcons } from "../src/branding/AppIconRenderer.ts";

const directory = new URL("../../web/public/app-branding/neutral-v1/", import.meta.url);
await mkdir(fileURLToPath(directory), { recursive: true });
for (const [variant, bytes] of await renderNeutralAppIcons()) {
  await writeFile(new URL(`${variant}.png`, directory), bytes);
}
