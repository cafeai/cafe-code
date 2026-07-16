import { describe, expect, it } from "vitest";

import {
  PROVIDER_PIPELINE_POLICY,
  encodedJsonByteLength,
  utf8ByteLength,
  validateProviderPipelinePolicy,
} from "./providerPipelinePolicy.ts";

describe("provider pipeline policy", () => {
  it("uses finite byte and work limits with valid water marks", () => {
    expect(() => validateProviderPipelinePolicy(PROVIDER_PIPELINE_POLICY)).not.toThrow();
    expect(PROVIDER_PIPELINE_POLICY.bridgeQueueLowWaterBytes).toBeLessThan(
      PROVIDER_PIPELINE_POLICY.bridgeQueueHighWaterBytes,
    );
    expect(PROVIDER_PIPELINE_POLICY.bridgeQueueHighWaterBytes).toBeLessThanOrEqual(
      PROVIDER_PIPELINE_POLICY.bridgeQueueMaxBytes,
    );
  });

  it("measures encoded UTF-8 bytes instead of JavaScript code units", () => {
    expect("🙂".length).toBe(2);
    expect(utf8ByteLength("🙂")).toBe(4);
  });

  it("records deterministic redacted fixture sizes for every transport shape", () => {
    const providerEvent = {
      eventId: "event-inventory",
      type: "item.completed",
      payload: { itemType: "command_execution", output: "x".repeat(2_147_130) },
    };
    const daemonEnvelope = {
      cursor: 1,
      emittedAt: "2026-07-16T00:00:00.000Z",
      event: { eventId: "event-compact", type: "item.completed", preview: "x".repeat(8_192) },
    };
    const shellSnapshot = {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: Array.from({ length: 8 }, (_, index) => ({ id: `project-${index}` })),
        threads: Array.from({ length: 32 }, (_, index) => ({
          id: `thread-${index}`,
          title: `Synthetic thread ${index}`,
        })),
      },
    };
    const threadSnapshot = {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: {
          id: "thread-inventory",
          messages: Array.from({ length: 2_000 }, (_, index) => ({
            id: `message-${index}`,
            role: index % 2 === 0 ? "user" : "assistant",
            text: "m".repeat(2_048),
          })),
          activities: Array.from({ length: 500 }, (_, index) => ({
            id: `activity-${index}`,
            summary: "bounded activity",
          })),
        },
      },
    };
    const unaryResponse = {
      ok: true,
      value: { providers: Array.from({ length: 64 }, () => ({})) },
    };
    const streamEvent = { kind: "event", event: daemonEnvelope.event };
    const sizes = {
      providerEvent: encodedJsonByteLength(providerEvent),
      daemonEnvelope: encodedJsonByteLength(daemonEnvelope),
      shellSnapshot: encodedJsonByteLength(shellSnapshot),
      threadSnapshot: encodedJsonByteLength(threadSnapshot),
      unaryResponse: encodedJsonByteLength(unaryResponse),
      streamEvent: encodedJsonByteLength(streamEvent),
    };

    expect(sizes.providerEvent).toBeGreaterThan(2 * 1024 * 1024);
    expect(sizes.daemonEnvelope).toBeLessThan(PROVIDER_PIPELINE_POLICY.ndjsonMaxLineBytes);
    expect(sizes.shellSnapshot).toBeLessThan(PROVIDER_PIPELINE_POLICY.webSocketMaxFrameBytes);
    expect(sizes.threadSnapshot).toBeGreaterThan(4 * 1024 * 1024);
    expect(sizes.threadSnapshot).toBeLessThan(PROVIDER_PIPELINE_POLICY.webSocketMaxFrameBytes);
    expect(sizes.unaryResponse).toBeLessThan(
      PROVIDER_PIPELINE_POLICY.webSocketReservedControlBytes,
    );
    expect(sizes.streamEvent).toBeLessThan(PROVIDER_PIPELINE_POLICY.webSocketMaxFrameBytes);
  });
});
