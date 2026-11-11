import { installApplicationRuntimeDependencies } from "../../../packages/shared/src/runtimeDependencies.ts";

installApplicationRuntimeDependencies(new URL(import.meta.url));
// Keep the application graph behind an actual dynamic import. Static imports
// resolve before loader installation and could borrow development packages.
if (process.argv[2] === "--cafe-secret-exec") {
  // A native shell tool owns this one-shot helper. It must never initialize
  // backend/profile locks, HTTP listeners, provider layers or the normal CLI.
  const runner = (await import(
    new URL("./secret-runner.mjs", import.meta.url).href
  )) as typeof import("./secrets/runnerEntry.ts");
  await runner.runSecretRunner(process.argv.slice(3));
} else {
  const application = (await import(
    new URL("./backend.mjs", import.meta.url).href
  )) as typeof import("./bin.ts");
  application.runCli();
}
