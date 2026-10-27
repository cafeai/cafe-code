import { runLocalBridge } from "./localBridge.ts";

/** Every shipped Glide MCP entry uses the owning chat's current grant. */
export async function runGlideBridge(
  args: readonly string[] = process.argv.slice(2),
  transport: Pick<Parameters<typeof runLocalBridge>[0], "input" | "output"> = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> {
  const connectionPath = args[0];
  if (args.length !== 1 || !connectionPath || connectionPath.startsWith("-")) {
    throw new Error("Glide requires an authorized Cafe chat connection.");
  }
  await runLocalBridge({
    ...transport,
    connectionPath,
    target: "cafe-glide",
  });
}
