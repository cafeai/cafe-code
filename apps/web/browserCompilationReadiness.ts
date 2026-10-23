import type { DevEnvironment } from "vite";

const MAX_MODULES = 20_000;
const MAX_URL_LENGTH = 8192;

/**
 * Prepare only inert compilation in the SAME client environment that will
 * serve the tests. Babel's async entrypoint still performs synchronous compiler
 * work; another file's cold collection must not occupy native input deadlines.
 * No module is imported/evaluated here, no browser/provider is started, and no
 * action, fixture readiness or native locator warm-up moves into preparation.
 *
 * Vite's convenience warm-up logs and swallows failures, and its idle finder is
 * one-shot. Instead await each real transform and its public import graph until
 * the complete reachable closure settles. Every invocation has fresh ownership;
 * a prior successful walk cannot stand in for changed/failed current source.
 */
export async function prepareBrowserCompilation(
  environment: Pick<DevEnvironment, "transformRequest" | "moduleGraph">,
  seedUrls: readonly string[],
  assertActive: () => void = () => undefined,
): Promise<number> {
  const scheduled = new Set<string>();
  const queue: string[] = [];
  const admit = (url: string) => {
    assertActive();
    if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH)
      throw new Error("Browser compilation received an unsupported module URL.");
    if (scheduled.has(url)) return;
    if (scheduled.size >= MAX_MODULES)
      throw new Error("Browser compilation exceeded its finite module bound.");
    // Admission, not completion, owns deduplication. Cycles and shared imports
    // cannot produce a quadratic pending queue before a module is transformed.
    scheduled.add(url);
    queue.push(url);
  };
  for (const seed of seedUrls) admit(seed);
  for (let index = 0; index < queue.length; index++) {
    assertActive();
    const url = queue[index]!;
    const transformed = await environment.transformRequest(url);
    assertActive();
    if (!transformed)
      throw new Error("Browser compilation did not produce its current transformed module.");
    const module = await environment.moduleGraph.getModuleByUrl(url);
    assertActive();
    if (!module) throw new Error("Browser compilation did not retain its current module graph.");
    for (const dependency of module.importedModules) {
      // Binary assets do not contain compiler work. CSS and JavaScript retain
      // their real transforms, including the original plugins and diagnostics.
      if (dependency.type !== "asset") admit(dependency.url);
    }
  }
  return scheduled.size;
}
