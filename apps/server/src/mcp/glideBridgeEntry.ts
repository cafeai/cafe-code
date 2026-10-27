import { runGlideBridge } from "./glideBridge.ts";

runGlideBridge().catch(() => {
  process.stderr.write("The Glide chat connection closed.\n");
  process.exitCode = 1;
});
