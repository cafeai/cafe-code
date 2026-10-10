import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { requestNativeControlHost, type NativeToolResult } from "@cafecode/shared/nativeControl";
import { NativeControlHost } from "./NativeControlHost.ts";
import { NativeDaemon } from "./NativeDaemon.ts";

const require = createRequire(import.meta.url);
type Fields = Record<string, unknown>;

async function fieldFixture() {
  const profile = await mkdtemp(join(tmpdir(), "cafe-cua-input-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(
    require("electron") as string,
    [fileURLToPath(new URL("./__fixtures__/electron-field.cjs", import.meta.url)), profile],
    { env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, (value: Fields) => void>();
  let nextId = 0;
  let ready: (value: Fields) => void;
  const readiness = new Promise<Fields>((resolve, reject) => {
    ready = resolve;
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("The owned Electron fixture exited before readiness.")),
    );
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Fields;
    if (value.ready) ready(value);
    else replies.get(Number(value.id))?.(value);
  });
  // Consume logs without treating Chromium diagnostics as protocol replies.
  child.stderr.resume();
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = async () => {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
      lines.close();
      await rm(profile, { recursive: true, force: true });
    }
  };
  try {
    const deadline = setTimeout(() => child.kill("SIGTERM"), 20_000);
    let info: Fields;
    try {
      info = await readiness;
    } finally {
      clearTimeout(deadline);
    }
    return {
      pid: Number(info.pid),
      state: () =>
        new Promise<Fields>((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            replies.delete(id);
            reject(new Error("The Electron input-state reply timed out."));
          }, 5000);
          replies.set(id, (value) => {
            clearTimeout(timeout);
            replies.delete(id);
            resolve(value);
          });
          child.stdin.write(JSON.stringify({ id, operation: "state" }) + "\n");
        }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// Opt-in GUI qualification uses the actual pinned Cua runtime and exact owned
// Electron process. It types only into this disposable field, never a user app.
// Requires pre-existing macOS Accessibility/Screen Recording grants; no prompts.
it.runIf(process.env.CAFE_CODE_CUA_INPUT_E2E === "1" && process.platform === "darwin")(
  "delivers bound text and submission to a real Electron field without duplicated input",
  async () => {
    const started = performance.now();
    let calls = 0;
    let nativeCalls = 0;
    const receipts: Fields[] = [];
    const field = await fieldFixture();
    const daemon = new NativeDaemon(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../..",
        "native/cua-driver/runtime",
        `${process.platform}-${process.arch}`,
      ),
      "com.cafecode.NativeInputFixture",
    );
    const host = new NativeControlHost({
      stateDirectory: "unused-without-publication",
      runtimeRoot: join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../..",
        "native/cua-driver/runtime",
        `${process.platform}-${process.arch}`,
      ),
      hostBundleId: "com.cafecode.NativeInputFixture",
      controller: {
        start: () => daemon.start(),
        stop: () => daemon.stop(),
        health: () => daemon.health(),
        session: async (label) => {
          const connection = await daemon.session(label);
          return {
            close: () => connection.close(),
            request: async (body) => {
              const response = await connection.request(body);
              if (body.method === "trusted_session_call") {
                nativeCalls++;
                if (["click", "hotkey", "type_text", "press_key"].includes(String(body.name)))
                  receipts.push({
                    name: body.name,
                    args: body.args,
                    result: response.structuredContent ?? response.content,
                  });
              }
              return response;
            },
          };
        },
      },
    });
    try {
      const connection = await host.listen(false);
      expect((await host.setEnabled(true)).phase).toBe("ready");
      const threadId = ThreadId.make("isolated-computer-input");
      await host.setChatEnabled(threadId, true);
      const binding = await requestNativeControlHost(connection, "bind", {
        threadId,
        providerInstanceId: "isolated-provider",
        provider: "codex",
      });
      for (const operation of ["activate", "begin-turn"])
        await requestNativeControlHost(connection, operation, { token: binding.token });
      const call = async (name: string, args: Fields = {}) => {
        calls++;
        const response = await fetch(String(binding.url), {
          method: "POST",
          headers: { Authorization: `Bearer ${String(binding.token)}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        expect(response.ok).toBe(true);
        const { result } = (await response.json()) as { result: NativeToolResult };
        const text = result.content.find((part) => part.type === "text")?.text;
        return {
          ...result,
          data:
            typeof text === "string" && text.startsWith("{")
              ? (JSON.parse(text) as Fields)
              : undefined,
        };
      };
      const health = await call("health");
      expect(health.isError).not.toBe(true);
      const checks = health.structuredContent?.checks as Fields[];
      for (const name of ["tcc_accessibility", "tcc_screen_recording"])
        expect(
          checks.find((check) => check.name === name),
          "Native input requires existing " + name + " permission",
        ).toMatchObject({ status: "pass" });
      const selected = await call("computer_select", { pid: field.pid, view: "both" });
      expect(selected.isError, JSON.stringify(selected.data ?? selected.content)).not.toBe(true);
      const state = selected.data!.state as Fields;
      const input = (state.elements as Fields[]).find(
        (element) => element.label === "Cafe fixture field" && element.role === "AXTextField",
      );
      expect(input, JSON.stringify(state)).toBeDefined();
      const text = "Cafe native entrée ☕ 42";
      const batch = await call("computer_act", {
        target: selected.data!.target,
        actions: [
          { type: "type", element: input!.element_token, text },
          { type: "key", keys: ["return"] },
        ],
        view: "both",
      });
      const received = await field.state();
      expect(
        batch.isError,
        JSON.stringify({
          received,
          receipts,
          prior: input,
          current: ((batch.data?.state as Fields)?.elements as Fields[] | undefined)?.filter(
            (element) => element.role === "AXTextField",
          ),
          results: batch.data?.results,
          content: batch.data ? undefined : batch.content,
        }),
      ).not.toBe(true);
      expect(received.value).toBe(text);
      expect(received.inputs).toEqual(expect.arrayContaining([text]));
      expect(received.submissions).toEqual([text]);
      await call("release_control");
      const next = await call("computer_select", { pid: field.pid });
      expect(next.isError).not.toBe(true);
      expect(next.data!.target).not.toBe(selected.data!.target);
      expect((await call("computer_observe", { target: selected.data!.target })).isError).toBe(
        true,
      );
      const nextState = next.data!.state as Fields;
      const nextInput = (nextState.elements as Fields[]).find(
        (element) => element.label === "Cafe fixture field" && element.role === "AXTextField",
      );
      const replacement = "Replaced entrée ☕ 99";
      const replaced = await call("computer_act", {
        target: next.data!.target,
        actions: [
          { type: "type", element: nextInput!.element_token, text: replacement, replace: true },
          { type: "key", keys: ["return"] },
        ],
      });
      const final = await field.state();
      expect(replaced.isError, JSON.stringify({ final, results: replaced.data?.results })).not.toBe(
        true,
      );
      expect(final.value).toBe(replacement);
      expect(final.submissions).toEqual([text, replacement]);
      const clicks = (final.events as Fields[]).filter(
        (event) => event.type === "click" && event.target === "field",
      ).length;
      expect(clicks).toBe(2);
      const evidence = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../..",
        ".explorations/computer-use-implementation",
      );
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, "native-input-metrics.json"),
        JSON.stringify(
          {
            scenario: "disposable Electron Unicode insertion, replacement and submission",
            verified_batches: 2,
            submissions: (final.submissions as string[]).length,
            field_clicks: clicks,
            facade_calls: calls,
            native_calls: nativeCalls,
            same_turn_reacquisition: true,
            old_handle_rejected: true,
            elapsed_ms: Math.round(performance.now() - started),
            user_applications: 0,
            clipboard_edits: 0,
            paid_provider_calls: 0,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await host.close();
      await field.close();
    }
  },
  60_000,
);
