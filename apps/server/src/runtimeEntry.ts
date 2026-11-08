import { installApplicationRuntimeDependencies } from "../../../packages/shared/src/runtimeDependencies.ts";

installApplicationRuntimeDependencies(new URL(import.meta.url));
// Keep the application graph behind an actual dynamic import. Static imports
// resolve before loader installation and could borrow development packages.
const application = (await import(
  new URL("./backend.mjs", import.meta.url).href
)) as typeof import("./bin.ts");
application.runCli();
