import { runLocalBridge } from "./localBridge.ts";

// The argument is an opaque private-file location, never a token, account, or
// model-selected chat ID. This entrypoint is copied as a standalone bundle.
const connectionPath = process.argv[2];
if (!connectionPath || process.argv.length !== 3) {
  process.stderr.write("Scheduled follow-ups require a Cafe session connection.\n");
  process.exitCode = 1;
} else {
  runLocalBridge({
    connectionPath,
    target: "cafe-scheduling",
    input: process.stdin,
    output: process.stdout,
  }).catch(() => {
    process.stderr.write(
      "The Cafe scheduling session disconnected. Resume the chat to reconnect.\n",
    );
    process.exitCode = 1;
  });
}
