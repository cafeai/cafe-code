import { buildBrowserBridgeFixtures } from "./lib/browser-test-artifacts.ts";
import { testRepositoryRoot } from "./lib/test-run-plan.ts";

const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  !args[0] ||
  !/^(0|[1-9][0-9]{0,30})$/.test(args[1]!) ||
  !/^(0|[1-9][0-9]{0,30})$/.test(args[2]!)
) {
  throw new Error("Browser bridge preparation requires its exact owned temporary directory.");
}
await buildBrowserBridgeFixtures(
  testRepositoryRoot,
  Object.freeze({
    path: args[0],
    device: args[1]!,
    inode: args[2]!,
  }),
);
