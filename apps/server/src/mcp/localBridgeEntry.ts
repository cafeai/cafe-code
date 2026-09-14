import { runLocalBridge } from "./localBridge.ts";

// A separate bundle entry keeps main-module checks out of server imports.
const connectionPath = process.argv[2];
if (!connectionPath || process.argv.length !== 3) {
  process.stderr.write("Usage: cafe-mcp-bridge <private-connection-file>\n");
  process.exitCode = 1;
} else {
  runLocalBridge({ connectionPath, input: process.stdin, output: process.stdout }).catch(() => {
    // Exceptions can contain paths, auth headers, request arguments or results.
    process.stderr.write("Cafe MCP bridge stopped. Check Settings → MCP in Cafe Code.\n");
    process.exitCode = 1;
  });
}
