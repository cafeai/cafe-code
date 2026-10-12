import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { requestNativeControlHost, type NativeToolResult } from "@cafecode/shared/nativeControl";
import { NativeControlHost } from "./NativeControlHost.ts";
import { NativeDaemon } from "./NativeDaemon.ts";

import { fieldFixture } from "./__fixtures__/electronFixture.ts";
type Fields = Record<string, unknown>;

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
      const wheelState = await call("computer_select", { pid: field.pid, view: "both" });
      expect(wheelState.isError).not.toBe(true);
      const wheelObservation = wheelState.data!.state as Fields;
      const wheel = (wheelObservation.elements as Fields[]).find(
        (e) => e.label === "Cafe fixture color wheel",
      );
      expect(wheel).toBeDefined();
      const frame = wheel!.screenshot_frame as { x: number; y: number; w: number; h: number };
      expect(frame).toBeDefined();
      const pointerBefore = (await field.state()).pointer;
      const wheelClick = await call("computer_advanced", {
        operation: "call",
        name: "click",
        arguments: {
          pid: field.pid,
          window_id: wheelObservation.window_id,
          capture_id: wheelObservation.capture_id,
          input_route: "pointer",
          delivery_mode: "foreground",
          x: frame.x + frame.w * 0.1,
          y: frame.y + frame.h / 2,
          observe_after: false,
        },
      });
      expect(wheelClick.isError, JSON.stringify(wheelClick)).not.toBe(true);
      const wheelReceived = await field.state();
      expect(wheelReceived.wheelClicks).toEqual([
        expect.objectContaining({ x: expect.any(Number) }),
      ]);
      expect((wheelReceived.wheelClicks as Fields[])[0]!.x).toBeGreaterThan(20);
      expect((wheelReceived.wheelClicks as Fields[])[0]!.x).toBeLessThan(45);
      expect(wheelReceived.pointer).toEqual(pointerBefore);
      const refusedForeground = await call("computer_advanced", {
        operation: "call",
        input_policy: "background-only",
        name: "click",
        arguments: {
          pid: field.pid,
          window_id: wheelObservation.window_id,
          delivery_mode: "foreground",
          x: 10,
          y: 10,
        },
      });
      expect(refusedForeground.isError).toBe(true);
      expect((await field.state()).wheelClicks).toEqual(wheelReceived.wheelClicks);
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
