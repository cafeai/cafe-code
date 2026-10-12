import { runLocalBridge } from "./localBridge.ts";

// This is a dedicated session audience; no provider profile or broad owner MCP
// installation can discover it. The sole argv contains a private capability file.
const connectionPath = process.argv[2];
if (!connectionPath || process.argv.length !== 3) {
  process.stderr.write("Visualizations require a Cafe session connection.\n");
  process.exitCode = 1;
} else {
  runLocalBridge({
    connectionPath,
    target: "cafe-visualizations",
    input: process.stdin,
    output: process.stdout,
  }).catch(() => {
    process.stderr.write(
      "The Cafe visualization session disconnected. Resume the chat to reconnect.\n",
    );
    process.exitCode = 1;
  });
}
