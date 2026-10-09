import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { NATIVE_CONTROL_ENVIRONMENT } from "@cafecode/shared/nativeControl";
import { verifyNativeRuntime } from "@cafecode/shared/nativeRuntime";
import release from "../native/cua-driver/release.json" with { type: "json" };
import descriptions from "../native/cua-driver/tool-policy.json" with { type: "json" };

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const reserved = new Set([
  "session",
  "cursor_id",
  "screenshot_out_file",
  "debug_image_out",
  "output_file",
  "capture_mode",
]);

// Long upstream property explanations repeat the tool-level guidance. Keep
// every machine constraint and the first sentence of long explanatory prose.
function shortenDescriptions(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "description" && typeof item === "string" && item.length > 320)
      (value as Record<string, unknown>)[key] = item.split(/(?<=\.)\s/u)[0];
    else shortenDescriptions(item);
  }
}

// Extract the actual pinned Mac registry, not its smaller portable contract.
// The direct MCP runtime is used only for initialize/tools/list: no tool is
// invoked, no AppKit overlay is created, and no permission request is made.
// Run after cua:prepare when upgrading; tool-policy.json controls the public
// local feature set and concise guidance independently of the upstream pin.
async function main(): Promise<void> {
  const executable = await verifyNativeRuntime(
    join(root, "native/cua-driver/runtime", `${process.platform}-${process.arch}`),
  );
  const temporary = await fs.mkdtemp(join(tmpdir(), "cafe-cua-catalog-"));
  const child = spawn(executable, ["mcp", "--direct", "--embedded"], {
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      HOME: temporary,
      CUA_DRIVER_RS_HOME: temporary,
      ...NATIVE_CONTROL_ENVIRONMENT,
    },
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.stdin.on("error", () => {
    /* An exited schema child cannot accept further requests. */
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  const lines = createInterface({ input: child.stdout });
  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cafe-catalog", version: "1" } } })}\n`,
    );
    let registry:
      | {
          name: string;
          inputSchema: Record<string, unknown>;
          annotations?: Record<string, unknown>;
        }[]
      | undefined;
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.error) throw new Error("Pinned Cua schema export was refused.");
      if (message.id === 1) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
        );
      }
      if (message.id === 2) {
        registry = message.result.tools;
        break;
      }
    }
    if (!registry) throw new Error("Pinned Cua exited before exporting its registry.");
    const tools = Object.entries(descriptions)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, description]) => {
        const native = registry.find((tool) => tool.name === name);
        if (!native)
          throw new Error(
            `Pinned Cua is missing ${name}; review the tool policy before upgrading.`,
          );
        const inputSchema = structuredClone(native.inputSchema);
        const properties = inputSchema.properties as Record<string, unknown>;
        for (const key of reserved) delete properties[key];
        if (Array.isArray(inputSchema.required))
          inputSchema.required = inputSchema.required.filter((key) => !reserved.has(key));
        inputSchema.additionalProperties = false;
        shortenDescriptions(inputSchema);
        return { name, description, inputSchema, annotations: native.annotations };
      });
    await fs.writeFile(
      join(root, "native/cua-driver/catalog.json"),
      `${JSON.stringify({ sourceCommit: release.sourceCommit, contractVersion: "0.8.0", schemaSource: "pinned-macos-native-registry", tools }, null, 2)}\n`,
    );
    process.stdout.write(`Exported ${tools.length} pinned Mac Cua tools.\n`);
  } finally {
    lines.close();
    child.stdin.end();
    // Retire only this owned schema child; keep its deadline until exit.
    await exited;
    clearTimeout(timer);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
await main();
