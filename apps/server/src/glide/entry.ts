import { runGlideBridge } from "../mcp/glideBridge.ts";

// Retain the historical entry name without its independent native runtime.
// Caller-supplied helper paths and app allowlists cannot grant chat access.
export { runGlideBridge as runGlideMcp } from "../mcp/glideBridge.ts";

if (import.meta.main) {
  runGlideBridge().catch(() => {
    process.stderr.write("Glide requires an authorized Cafe chat connection.\n");
    process.exitCode = 1;
  });
}
