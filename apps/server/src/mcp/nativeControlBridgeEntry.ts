import { runLocalBridge } from "./localBridge.ts";

const connectionPath = process.argv[2];
if (!connectionPath || process.argv.length !== 3) {
  process.stderr.write("Native desktop tools require a private Cafe session connection.\n");
  process.exitCode = 1;
} else {
  runLocalBridge({
    connectionPath,
    target: "cafe-native-control",
    input: process.stdin,
    output: process.stdout,
  }).catch(() => {
    process.stderr.write(
      "Native desktop control disconnected. Resume the Cafe conversation to reconnect.\n",
    );
    process.exitCode = 1;
  });
}
