import { runLocalBridge } from "./localBridge.ts";

const connectionPath = process.argv[2];
if (!connectionPath || process.argv.length !== 3) {
  process.stderr.write("Desktop Control requires a Cafe session connection.\n");
  process.exitCode = 1;
} else {
  runLocalBridge({
    connectionPath,
    target: "cafe-desktop",
    input: process.stdin,
    output: process.stdout,
  }).catch(() => {
    process.stderr.write(
      "Desktop Control disconnected. Check the selected Desktop in Cafe Code.\n",
    );
    process.exitCode = 1;
  });
}
