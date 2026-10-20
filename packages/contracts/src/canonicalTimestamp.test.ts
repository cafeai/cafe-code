import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { CodexCompactionUsageObservation } from "./codexCompactionDiagnostics.ts";
import { OrchestrationThreadTurnSubagentDetailMessage } from "./orchestration.ts";
import { ProviderSessionQuotaTimestamp } from "./providerQuota.ts";
import { ScheduledFollowupTimestamp } from "./scheduledFollowups.ts";
import { UsageStatsModelGeneratingTimeStartedAt } from "./usageStats.ts";
import { VisualizationListInput } from "./visualizationApi.ts";

// Exercise the actual received-data boundaries, not a second implementation of
// ISO parsing. Early civil years must not acquire Date.UTC's 1900 offset, and
// impossible calendar dates must not become valid after native rollover.
const boundaries = [
  ["scheduled instants", Schema.is(ScheduledFollowupTimestamp)],
  ["quota observation", Schema.is(ProviderSessionQuotaTimestamp)],
  ["generating-time origin", Schema.is(UsageStatsModelGeneratingTimeStartedAt)],
  [
    "visualization viewport",
    (value: string) =>
      Schema.is(VisualizationListInput)({ threadId: "thread-1", atOrBefore: value }),
  ],
  [
    "subagent display provenance",
    (value: string) =>
      Schema.is(OrchestrationThreadTurnSubagentDetailMessage)({
        key: "message-1",
        role: "assistant",
        text: "done",
        timestamp: value,
      }),
  ],
  [
    "compaction sample",
    (value: string) =>
      Schema.is(CodexCompactionUsageObservation)({
        observedAt: value,
        order: 0,
        nativeTurnId: null,
        usedTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalProcessedTokens: 0,
        reportedUsableContextWindow: null,
      }),
  ],
] as const;

describe.each(boundaries)("canonical UTC %s", (_name, admits) => {
  it.each([
    "0000-02-29T00:00:00.000Z",
    "0099-01-01T00:00:00.000Z",
    "2000-02-29T23:59:59.999Z",
    "9999-12-31T23:59:59.999Z",
  ])("retains exact valid civil instant %s", (value) => expect(admits(value)).toBe(true));

  it.each([
    "0001-02-29T00:00:00.000Z",
    "1900-02-29T00:00:00.000Z",
    "2026-02-30T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-01-01T24:00:00.000Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.000+00:00",
    "+010000-01-01T00:00:00.000Z",
    "not-an-instant",
  ])("rejects invalid or noncanonical instant %s", (value) => expect(admits(value)).toBe(false));
});
