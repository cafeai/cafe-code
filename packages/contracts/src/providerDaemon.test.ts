import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProviderDaemonSubagentDetail } from "./providerDaemon.ts";

const decodeProviderDaemonSubagentDetail = Schema.decodeUnknownEffect(ProviderDaemonSubagentDetail);

it.effect("bounds provider-daemon subagent detail by aggregate UTF-8 bytes", () =>
  Effect.gen(function* () {
    const detail = yield* decodeProviderDaemonSubagentDetail({
      provider: "claudeAgent",
      providerInstanceId: "claude-primary",
      messages: [
        { key: "m0", role: "user", text: "Audit the provider" },
        { key: "m1", role: "assistant", text: "Done." },
      ],
      gaps: [],
      truncated: false,
    });
    assert.equal(detail.provider, "claudeAgent");

    const overflow = yield* Effect.exit(
      decodeProviderDaemonSubagentDetail({
        provider: "codex",
        providerInstanceId: "codex",
        messages: Array.from({ length: 5 }, (_, index) => ({
          key: `m${index}`,
          role: "assistant",
          // 8,192 four-byte scalars exactly fill the per-message limit; the
          // fifth message crosses only the aggregate boundary.
          text: "🙂".repeat(8_192),
        })),
        gaps: [],
        truncated: true,
      }),
    );
    assert.equal(overflow._tag, "Failure");
  }),
);

it.effect("shares stable omission invariants with the orchestration detail contract", () =>
  Effect.gen(function* () {
    for (const invalid of [
      {
        provider: "codex",
        providerInstanceId: "codex",
        messages: [
          { key: "m0", role: "user", text: "Assignment" },
          { key: "m0", role: "assistant", text: "Latest" },
        ],
        gaps: [],
        truncated: false,
      },
      {
        provider: "codex",
        providerInstanceId: "codex",
        messages: [
          { key: "m0", role: "user", text: "Assignment" },
          { key: "m1", role: "assistant", text: "Stale" },
        ],
        gaps: [{ afterMessageKey: "m1", omittedMessages: 1, omittedUtf8Bytes: 8 }],
        truncated: true,
      },
      {
        provider: "codex",
        providerInstanceId: "codex",
        messages: [
          {
            key: "m0",
            role: "assistant",
            text: "Head",
            omission: { tail: "tail", omittedUtf8Bytes: 8 },
          },
        ],
        gaps: [],
        truncated: false,
      },
    ] as const) {
      const exit = yield* Effect.exit(decodeProviderDaemonSubagentDetail(invalid));
      assert.equal(exit._tag, "Failure");
    }
  }),
);
