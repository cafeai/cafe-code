// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as http from "node:http";

import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import {
  encodedJsonByteLength,
  PROVIDER_PIPELINE_POLICY,
} from "@cafecode/shared/providerPipelinePolicy";
import { compactProviderRuntimeEvent } from "@cafecode/shared/providerRuntimeEventCompaction";
import { afterAll, assert, beforeAll, it } from "vitest";

const HEARTBEAT_INTERVAL_MS = 25;
const MAX_EVENT_LOOP_LAG_MS = 1_500;
const MAX_HEALTH_LATENCY_MS = 1_500;
const MAX_RSS_GROWTH_BYTES = 256 * 1024 * 1024;
const LOAD_EVENT_COUNT = 24;
const SOURCE_EVENT_BYTES = 2.2 * 1024 * 1024;

let server: http.Server;
let healthUrl = "";

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  healthUrl = `http://127.0.0.1:${address.port}/health`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

function makeLargeEvent(index: number): ProviderRuntimeEvent {
  return {
    type: "runtime.warning",
    eventId: EventId.make(`pipeline-load-${index}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("pipeline-load-thread"),
    createdAt: "2026-07-16T00:00:00.000Z",
    payload: {
      message: "x".repeat(SOURCE_EVENT_BYTES),
    },
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Opt-in real-timer proof for the incident's defining symptom: provider-sized
 * synchronous work must yield often enough that an unrelated HTTP health route
 * and heartbeat timer in the same backend process continue to make progress.
 * This deliberately uses synthetic content and no provider binary or credential.
 */
it("keeps health and heartbeat progress during repeated multi-megabyte event compaction", async () => {
  const rssBefore = process.memoryUsage.rss();
  const healthLatencies: number[] = [];
  const heartbeatLags: number[] = [];
  let expectedHeartbeatAt = performance.now() + HEARTBEAT_INTERVAL_MS;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    heartbeatLags.push(Math.max(0, now - expectedHeartbeatAt));
    expectedHeartbeatAt = now + HEARTBEAT_INTERVAL_MS;
  }, HEARTBEAT_INTERVAL_MS);

  try {
    for (let index = 0; index < LOAD_EVENT_COUNT; index += 1) {
      const compacted = compactProviderRuntimeEvent(makeLargeEvent(index));
      assert.isBelow(
        encodedJsonByteLength(compacted.event),
        PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes + 1,
      );

      const healthStartedAt = performance.now();
      const response = await fetch(healthUrl);
      healthLatencies.push(performance.now() - healthStartedAt);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      await yieldToEventLoop();
    }
  } finally {
    clearInterval(heartbeat);
  }

  assert.isNotEmpty(heartbeatLags);
  assert.isBelow(Math.max(...heartbeatLags), MAX_EVENT_LOOP_LAG_MS);
  assert.isBelow(Math.max(...healthLatencies), MAX_HEALTH_LATENCY_MS);
  assert.isBelow(process.memoryUsage.rss() - rssBefore, MAX_RSS_GROWTH_BYTES);
}, 60_000);
