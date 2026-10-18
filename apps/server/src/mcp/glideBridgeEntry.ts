import { runLocalBridge } from "./localBridge.ts";

const connectionPath = process.argv[2];
if (!connectionPath || process.argv.length !== 3) {
  process.stderr.write("Glide requires a Cafe chat connection.\n");
  process.exitCode = 1;
} else {
  runLocalBridge({
    connectionPath,
    target: "cafe-glide",
    input: process.stdin,
    output: process.stdout,
  }).catch(() => {
    process.stderr.write("The Glide chat connection closed.\n");
    process.exitCode = 1;
  });
}
