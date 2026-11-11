import { expect, it, vi } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { cafeSecretReference } from "@cafecode/shared/cafeSecrets";
import {
  makeClaudeSecretHooks,
  mapSecretStrings,
  supportsClaudeSecretHooks,
} from "./claudeHooks.ts";
import type { ThreadSecretsStore } from "./store.ts";

const id = "0123456789abcdef0123456789abcdef";
const invocation = "node /owned/bin.mjs --cafe-secret-exec /private/connection.json";
const hookInput = (event: Record<string, unknown>) =>
  ({
    session_id: "native",
    cwd: "/workspace",
    transcript_path: "/private/transcript",
    ...event,
  }) as HookInput;
const options = () => ({ signal: new AbortController().signal });
const make = (
  snapshot = async () => new Map([[id, "synthetic-secret-key"]]),
  isCurrent = () => true,
  version = "2.1.321",
) =>
  makeClaudeSecretHooks({
    store: { snapshot } as unknown as ThreadSecretsStore,
    threadId: "chat",
    nativeVersion: version,
    runnerInvocation: invocation,
    isCurrent,
    retire: vi.fn(async () => undefined),
  });

it("keeps native arguments opaque and leaves exact runner calls to ordinary authorization", async () => {
  const owner = make();
  const pre = owner.hooks.PreToolUse[0]!.hooks[0]!;
  expect(
    await pre(
      hookInput({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { content: cafeSecretReference(id) },
      }),
      "call",
      options(),
    ),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(
    await pre(
      hookInput({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `${invocation} '{"env":{"KEY":"${cafeSecretReference(id)}"}}'` },
      }),
      "call",
      options(),
    ),
  ).toEqual({});
});

it("redacts matching native output while preserving its structured output shape", async () => {
  const owner = make();
  await owner.hooks.PreToolUse[0]!.hooks[0]!(
    hookInput({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/workspace/file" },
    }),
    "call",
    options(),
  );
  const result = await owner.hooks.PostToolUse[0]!.hooks[0]!(
    hookInput({
      hook_event_name: "PostToolUse",
      tool_response: {
        stdout: "synthetic-secret-key",
        stderr: "",
        interrupted: false,
        isImage: false,
      },
      tool_name: "Bash",
      tool_input: {},
    }),
    "call",
    options(),
  );
  expect(result).toEqual({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: {
        stdout: cafeSecretReference(id),
        stderr: "",
        interrupted: false,
        isImage: false,
      },
    },
  });
});

it("withdraws delayed input admission when its exact query retires", async () => {
  let resolve!: (values: Map<string, string>) => void;
  const pending = new Promise<Map<string, string>>((done) => {
    resolve = done;
  });
  let current = true;
  const owner = make(
    () => pending,
    () => current,
  );
  const result = owner.hooks.PreToolUse[0]!.hooks[0]!(
    hookInput({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }),
    "call",
    options(),
  );
  current = false;
  resolve(new Map([[id, "synthetic-secret-key"]]));
  expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});

it("retains old-value output redaction after removal and denies unsupported native rewriting", async () => {
  let values = new Map([[id, "synthetic-secret-key"]]);
  const owner = make(async () => values);
  await owner.hooks.PreToolUse[0]!.hooks[0]!(
    hookInput({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }),
    "call",
    options(),
  );
  values = new Map();
  expect(owner.redact({ output: "synthetic-secret-key" })).toEqual({
    output: cafeSecretReference(id),
  });
  const old = make(undefined, undefined, "2.1.320");
  expect(
    await old.hooks.PreToolUse[0]!.hooks[0]!(
      hookInput({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { content: cafeSecretReference(id) },
      }),
      "call",
      options(),
    ),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(supportsClaudeSecretHooks("2.1.321-preview")).toBe(false);
  expect(supportsClaudeSecretHooks(undefined)).toBe(false);
});

it("never invokes received getters or prototype setters while transforming tool data", () => {
  const getter = vi.fn(() => "secret");
  const input = Object.defineProperty({}, "value", { get: getter, enumerable: true });
  expect(() => mapSecretStrings(input, (text) => text)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const inert = JSON.parse('{"__proto__":{"value":"secret"}}');
  expect(Object.getPrototypeOf(mapSecretStrings(inert, (text) => text))).toBe(Object.prototype);
});
