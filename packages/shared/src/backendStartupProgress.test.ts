import { describe, expect, it } from "vitest";

import {
  BACKEND_MIGRATION_STARTUP_BUDGET_MS,
  encodeBackendMigrationProgress,
  makeBackendMigrationProgressDecoder,
  makeBackendStartupDeadline,
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
