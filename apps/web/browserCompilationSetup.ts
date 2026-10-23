import type { TestProject } from "vitest/node";
import { prepareBrowserCompilation } from "./browserCompilationReadiness.ts";

/** Initial browser qualification preparation, before any test body is admitted. */
export default async function setup(project: TestProject): Promise<void> {
  let retired = false;
  const removeCancellation = project.vitest.onCancel(() => {
    retired = true;
  });
  const assertActive = () => {
    if (retired) throw new Error("Browser compilation preparation was cancelled.");
  };
  try {
    if (!project.isBrowserEnabled())
      throw new Error("Browser compilation preparation requires its exact browser project.");
    // Vitest records the actual run's paths and immutable project specifications
    // before awaiting global setup. Preserve CLI/file/project selection rather
    // than discovering unrelated files or warming native input utilities.
    const files = project.vitest.state
      .getPaths()
      .filter((file) =>
        project.vitest
          .getModuleSpecifications(file)
          .some((spec) => spec.project === project && spec.pool === "browser"),
      );
    if (files.length === 0)
      throw new Error("Browser compilation preparation has no exact selected specifications.");
    // Mirror the served file URL used by the pinned browser runner, including
    // Windows drive paths. Compilation remains in this server's ordinary client
    // environment, with its unchanged compiler/options and file-access policy.
    const urls = files.map((file) =>
      `/${/^\w:/.test(file) ? "@fs/" : ""}${file}`.replace(/\\/g, "/").replace(/\/+/g, "/"),
    );
    const environment = project.vite.environments.client;
    if (!environment || environment.config.consumer !== "client")
      throw new Error("Browser compilation preparation has no exact client environment.");
    const count = await prepareBrowserCompilation(environment, urls, assertActive);
    console.log(
      `Browser compilation prepared ${files.length} selected files and ${count} modules.`,
    );
  } finally {
    // Cancellation fences future admission without interrupting an in-flight
    // transform. Existing Vite retirement joins its own pending native work.
    removeCancellation();
  }
}
