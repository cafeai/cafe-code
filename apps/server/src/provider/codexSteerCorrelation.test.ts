import assert from "node:assert/strict";

import { MessageId } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";

import {
  buildCodexSteerClientCorrelationId,
  CODEX_STEER_CLIENT_CORRELATION_ID_BYTE_LENGTH,
  parseCodexSteerClientCorrelationId,
} from "./codexSteerCorrelation.ts";

const decodeMessageId = Schema.decodeUnknownSync(MessageId);

describe("Codex steer client correlation", () => {
  it("binds oversized and control-containing valid MessageIds to fixed content-free tokens", () => {
    const oversizedMessageId = decodeMessageId(`message-${"x".repeat(1_024)}`);
    const controlMessageId = decodeMessageId("message-\u0000-\u202e-\n-tail");

    const oversizedToken = buildCodexSteerClientCorrelationId(oversizedMessageId);
    const controlToken = buildCodexSteerClientCorrelationId(controlMessageId);

    assert.equal(
      Buffer.byteLength(oversizedToken, "utf8"),
      CODEX_STEER_CLIENT_CORRELATION_ID_BYTE_LENGTH,
    );
    assert.equal(
      Buffer.byteLength(controlToken, "utf8"),
      CODEX_STEER_CLIENT_CORRELATION_ID_BYTE_LENGTH,
    );
    assert.match(oversizedToken, /^cafe-steer-v1:[0-9a-f]{64}$/u);
    assert.match(controlToken, /^cafe-steer-v1:[0-9a-f]{64}$/u);
    assert.notEqual(oversizedToken, controlToken);
    assert.equal(oversizedToken.includes(String(oversizedMessageId)), false);
    assert.equal(/[\p{Cc}\p{Cf}\p{Cs}]/u.test(controlToken), false);
  });

  it("derives deterministically and round-trips only canonical restart tokens", () => {
    const messageId = decodeMessageId("message-\u0000-\u202e-restart");
    const beforeRestart = buildCodexSteerClientCorrelationId(messageId);
    const afterRestart = buildCodexSteerClientCorrelationId(messageId);

    assert.equal(afterRestart, beforeRestart);
    assert.equal(parseCodexSteerClientCorrelationId(beforeRestart), beforeRestart);
    assert.equal(parseCodexSteerClientCorrelationId(String(messageId)), undefined);
    assert.equal(parseCodexSteerClientCorrelationId(`${beforeRestart}0`), undefined);
    assert.equal(parseCodexSteerClientCorrelationId(beforeRestart.toUpperCase()), undefined);
  });

  it("cryptographically distinguishes valid ids containing different lone surrogates", () => {
    const first = decodeMessageId("message-\ud800-tail");
    const second = decodeMessageId("message-\ud801-tail");

    // Both values have the same lossy UTF-8 representation in Node. Hashing
    // their UTF-16 code units keeps the correlation binding exact instead of
    // allowing an adversarial MessageId collision before SHA-256 is applied.
    assert.deepEqual(Buffer.from(first, "utf8"), Buffer.from(second, "utf8"));
    assert.notEqual(
      buildCodexSteerClientCorrelationId(first),
      buildCodexSteerClientCorrelationId(second),
    );
  });
});
