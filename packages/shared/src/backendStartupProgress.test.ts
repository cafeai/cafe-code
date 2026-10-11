import { describe, expect, it } from "vitest";

import {
  BACKEND_MIGRATION_STARTUP_BUDGET_MS,
  encodeBackendMigrationProgress,
  makeBackendMigrationProgressDecoder,
  makeBackendStartupDeadline,
  makeProviderDaemonStartupProgressTracker,
  PROVIDER_DAEMON_MIGRATION_STARTUP_BUDGET_MS,
  type ProviderDaemonStartupProgress,
} from "./backendStartupProgress.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("private backend migration progress", () => {
  it("decodes split and coalesced ASCII records without exposing other content", () => {
    const decoder = makeBackendMigrationProgressDecoder();
    expect(decoder.push(bytes("cafe-migration:v1:sta")).records).toEqual([]);
    expect(decoder.push(bytes("rt:92\ncafe-migration:v1:complete:92\n"))).toEqual({
      invalid: false,
      records: [
        { phase: "start", migrationId: 92 },
        { phase: "complete", migrationId: 92 },
      ],
    });
    expect(decoder.end()).toBe(false);
  });

  it.each([
    "cafe-migration:v2:start:92\n",
    "cafe-migration:v1:unknown:92\n",
    "cafe-migration:v1:start:0\n",
    "cafe-migration:v1:start:092\n",
    "cafe-migration:v1:start:100000\n",
    "secret\u0000value\n",
    "x".repeat(97),
  ])("permanently rejects malformed or oversized frames", (input) => {
    const decoder = makeBackendMigrationProgressDecoder();
    expect(decoder.push(bytes(input))).toEqual({ invalid: true, records: [] });
    expect(decoder.push(bytes("cafe-migration:v1:start:92\n"))).toEqual({
      invalid: true,
      records: [],
    });
    expect(decoder.end()).toBe(true);
  });

  it("bounds lifetime bytes/records and rejects truncated EOF", () => {
    const decoder = makeBackendMigrationProgressDecoder();
    expect(decoder.push(new Uint8Array(65_537)).invalid).toBe(true);
    const flooded = makeBackendMigrationProgressDecoder();
    expect(flooded.push(bytes("cafe-migration:v1:start:1\n".repeat(2_049))).invalid).toBe(true);
    const truncated = makeBackendMigrationProgressDecoder();
    truncated.push(bytes("cafe-migration:v1:start:92"));
    expect(truncated.end()).toBe(true);
  });

  it("grants a finite cap and restores ordinary startup time after completion", () => {
    const deadline = makeBackendStartupDeadline(60_000);
    expect(deadline.deadlineMs).toBe(60_000);
    deadline.observe({ phase: "start", migrationId: 92 }, 59_999);
    expect(deadline.deadlineMs).toBe(BACKEND_MIGRATION_STARTUP_BUDGET_MS);
    deadline.observe({ phase: "complete", migrationId: 92 }, 100_000);
    expect(deadline.deadlineMs).toBe(160_000);
    deadline.observe({ phase: "start", migrationId: 93 }, 100_001);
    deadline.observe({ phase: "start", migrationId: 94 }, 500_000);
    deadline.observe({ phase: "start", migrationId: 94 }, 599_999);
    expect(deadline.deadlineMs).toBe(600_000);
    deadline.observe({ phase: "complete", migrationId: 94 }, 599_999);
    expect(deadline.deadlineMs).toBe(600_000);
  });

  it("cannot revive expired startup or renew the cap through duplicate starts", () => {
    const expired = makeBackendStartupDeadline(60_000);
    expired.observe({ phase: "start", migrationId: 92 }, 60_000);
    expect(expired.deadlineMs).toBe(60_000);
    const deadline = makeBackendStartupDeadline(60_000);
    deadline.observe({ phase: "start", migrationId: 92 }, 0);
    deadline.observe({ phase: "start", migrationId: 92 }, 600_001);
    expect(deadline.deadlineMs).toBe(600_000);
  });

  it("revokes invalid/mismatched evidence and fences observations after readiness", () => {
    const invalid = makeBackendStartupDeadline(60_000);
    invalid.observe({ phase: "start", migrationId: 92 }, 0);
    invalid.observe({ phase: "complete", migrationId: 93 }, 1);
    invalid.observe({ phase: "start", migrationId: 92 }, 2);
    expect(invalid.deadlineMs).toBe(60_000);
    const ready = makeBackendStartupDeadline(60_000);
    ready.finish();
    ready.observe({ phase: "start", migrationId: 92 }, 1);
    ready.invalidate();
    expect(ready.deadlineMs).toBe(60_000);
    expect(encodeBackendMigrationProgress({ phase: "failed", migrationId: 92 })).toBe(
      "cafe-migration:v1:failed:92\n",
    );
  });
});

describe("owned daemon startup feedback", () => {
  it("uses the daemon-only absolute cap and reports only accepted lifecycle evidence", () => {
    const records: ProviderDaemonStartupProgress[] = [];
    const tracker = makeProviderDaemonStartupProgressTracker(30_000, (record) =>
      records.push(record),
    );
    tracker.start();
    tracker.push(bytes("cafe-migration:v1:start:92\n"), 29_999);
    tracker.push(bytes("cafe-migration:v1:start:92\n"), 500_000);
    tracker.push(bytes("cafe-migration:v1:start:93\n"), 3_599_999);
    expect(tracker.deadlineMs).toBe(PROVIDER_DAEMON_MIGRATION_STARTUP_BUDGET_MS);
    tracker.push(bytes("cafe-migration:v1:complete:93\n"), 3_599_999);
    expect(tracker.deadlineMs).toBe(3_600_000);
    tracker.finish("ready");
    tracker.push(bytes("cafe-migration:v1:start:94\n"), 3_599_999);
    tracker.finish("failed");
    expect(records).toEqual([
      { phase: "starting" },
      { phase: "migrating", migrationId: 92 },
      { phase: "migrating", migrationId: 93 },
      { phase: "starting" },
      { phase: "ready" },
    ]);
    expect(makeBackendStartupDeadline(60_000).deadlineMs).toBe(60_000);
    const backend = makeBackendStartupDeadline(60_000);
    backend.observe({ phase: "start", migrationId: 92 }, 0);
    expect(backend.deadlineMs).toBe(600_000);
  });

  it.each(["cafe-migration:v2:start:92\n", "x".repeat(97), "PRIVATE_CREDENTIAL\n"])(
    "rejects malformed evidence without exposing bytes or renewing time",
    (invalid) => {
      const records: ProviderDaemonStartupProgress[] = [];
      const tracker = makeProviderDaemonStartupProgressTracker(30_000, (record) =>
        records.push(record),
      );
      tracker.start();
      tracker.push(bytes("cafe-migration:v1:start:92\n"), 0);
      tracker.push(bytes(invalid), 40_000);
      tracker.push(bytes("cafe-migration:v1:start:93\n"), 40_001);
      expect(tracker.deadlineMs).toBe(30_000);
      expect(records.at(-1)).toEqual({ phase: "starting" });
      expect(JSON.stringify(records)).not.toContain(invalid);
    },
  );

  it("rejects late phase evidence, truncated EOF and closed-pipe errors", () => {
    const late = makeProviderDaemonStartupProgressTracker(30_000);
    late.push(bytes("cafe-migration:v1:start:92\n"), 30_000);
    expect(late.deadlineMs).toBe(30_000);
    const truncated = makeProviderDaemonStartupProgressTracker(30_000);
    truncated.push(bytes("cafe-migration:v1:start:92\ncafe-migration:v1:complete:92"), 0);
    truncated.end();
    expect(truncated.deadlineMs).toBe(30_000);
    const errored = makeProviderDaemonStartupProgressTracker(30_000);
    errored.push(bytes("cafe-migration:v1:start:92\n"), 0);
    errored.invalidate();
    expect(errored.deadlineMs).toBe(30_000);
  });

  it("restores only ordinary post-migration time and keeps no-progress startup unchanged", () => {
    const tracker = makeProviderDaemonStartupProgressTracker(30_000);
    tracker.push(bytes("cafe-migration:v1:start:92\n"), 0);
    tracker.push(bytes("cafe-migration:v1:complete:92\n"), 60_000);
    expect(tracker.deadlineMs).toBe(90_000);
    expect(makeProviderDaemonStartupProgressTracker(30_000).deadlineMs).toBe(30_000);
  });
});
