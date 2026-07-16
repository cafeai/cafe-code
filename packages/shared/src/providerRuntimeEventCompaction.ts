// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";

import type { ProviderRuntimeEvent } from "@cafecode/contracts";

import {
  PROVIDER_PIPELINE_POLICY,
  type ProviderPipelinePolicy,
  utf8ByteLength,
} from "./providerPipelinePolicy.ts";

const IDENTITY_KEYS = new Set([
  "eventId",
  "threadId",
  "turnId",
  "itemId",
  "requestId",
  "taskId",
  "hookId",
  "toolUseId",
  "providerThreadId",
  "providerTurnId",
  "providerItemId",
  "providerRequestId",
  "realtimeSessionId",
]);
const COMMAND_KEYS = new Set(["command", "cmd", "argv"]);

interface MutableCompactionStats {
  truncatedStrings: number;
  omittedArrayItems: number;
  omittedObjectKeys: number;
  depthOmissions: number;
}

export interface ProviderRuntimeEventCompactionStats extends MutableCompactionStats {
  readonly compacted: boolean;
  readonly originalEncodedBytes: number;
  readonly compactedEncodedBytes: number;
  readonly sha256: string | null;
}

export interface CompactProviderRuntimeEventResult {
  readonly event: ProviderRuntimeEvent;
  readonly stats: ProviderRuntimeEventCompactionStats;
}

function safePreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const end = Math.max(0, maxChars - 1);
  const preview = value.slice(0, end);
  const last = preview.charCodeAt(preview.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? preview.slice(0, -1) : preview}…`;
}

function compactUnknown(
  value: unknown,
  key: string | null,
  depth: number,
  stats: MutableCompactionStats,
  policy: ProviderPipelinePolicy,
  aggressive: boolean,
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (key !== null && IDENTITY_KEYS.has(key) && !aggressive) return value;
    const normalLimit =
      key !== null && COMMAND_KEYS.has(key)
        ? policy.canonicalCommandPreviewChars
        : policy.canonicalTextPreviewChars;
    const limit = aggressive ? Math.min(normalLimit, 1_024) : normalLimit;
    if (value.length <= limit) return value;
    stats.truncatedStrings += 1;
    return safePreview(value, limit);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === undefined) return String(value);
  if (depth >= policy.canonicalMaxDepth) {
    stats.depthOmissions += 1;
    return Array.isArray(value)
      ? `[array omitted at depth ${depth}]`
      : `[object omitted at depth ${depth}]`;
  }
  if (Array.isArray(value)) {
    const maxItems = aggressive
      ? Math.min(policy.canonicalMaxArrayItems, 16)
      : policy.canonicalMaxArrayItems;
    const output = value
      .slice(0, maxItems)
      .map((entry) => compactUnknown(entry, null, depth + 1, stats, policy, aggressive));
    if (value.length > maxItems) {
      stats.omittedArrayItems += value.length - maxItems;
      output.push(`[${value.length - maxItems} items omitted]`);
    }
    return output;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const maxKeys = aggressive
    ? Math.min(policy.canonicalMaxObjectKeys, 32)
    : policy.canonicalMaxObjectKeys;
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries.slice(0, maxKeys)) {
    output[entryKey] = compactUnknown(entryValue, entryKey, depth + 1, stats, policy, aggressive);
  }
  if (entries.length > maxKeys) {
    stats.omittedObjectKeys += entries.length - maxKeys;
    output.cafecodeOmittedKeyCount = entries.length - maxKeys;
  }
  return output;
}

function withCompactionMetadata(
  event: ProviderRuntimeEvent,
  originalEncodedBytes: number,
  sha256: string,
  stats: MutableCompactionStats,
): ProviderRuntimeEvent {
  return {
    ...event,
    compaction: {
      version: 1,
      originalEncodedBytes,
      compactedEncodedBytes: 0,
      sha256,
      truncatedStrings: stats.truncatedStrings,
      omittedArrayItems: stats.omittedArrayItems,
      omittedObjectKeys: stats.omittedObjectKeys,
      depthOmissions: stats.depthOmissions,
    },
  } as ProviderRuntimeEvent;
}

export function compactProviderRuntimeEvent(
  original: ProviderRuntimeEvent,
  policy: ProviderPipelinePolicy = PROVIDER_PIPELINE_POLICY,
): CompactProviderRuntimeEventResult {
  const originalJson = JSON.stringify(original);
  const originalEncodedBytes = utf8ByteLength(originalJson);
  if (originalEncodedBytes <= policy.canonicalEventMaxBytes) {
    return {
      event: original,
      stats: {
        compacted: false,
        originalEncodedBytes,
        compactedEncodedBytes: originalEncodedBytes,
        sha256: null,
        truncatedStrings: 0,
        omittedArrayItems: 0,
        omittedObjectKeys: 0,
        depthOmissions: 0,
      },
    };
  }

  const sha256 = Crypto.createHash("sha256").update(originalJson, "utf8").digest("hex");
  let stats: MutableCompactionStats = {
    truncatedStrings: 0,
    omittedArrayItems: 0,
    omittedObjectKeys: 0,
    depthOmissions: 0,
  };
  let compacted = withCompactionMetadata(
    {
      ...original,
      payload: compactUnknown(original.payload, null, 0, stats, policy, false),
      ...(original.raw === undefined
        ? {}
        : {
            raw: {
              ...original.raw,
              payload: compactUnknown(original.raw.payload, null, 0, stats, policy, false),
            },
          }),
    } as ProviderRuntimeEvent,
    originalEncodedBytes,
    sha256,
    stats,
  );

  let compactedBytes = utf8ByteLength(JSON.stringify(compacted));
  if (compactedBytes > policy.canonicalEventMaxBytes) {
    stats = {
      truncatedStrings: 0,
      omittedArrayItems: 0,
      omittedObjectKeys: 0,
      depthOmissions: 0,
    };
    compacted = withCompactionMetadata(
      {
        ...original,
        payload: compactUnknown(original.payload, null, 0, stats, policy, true),
      } as ProviderRuntimeEvent,
      originalEncodedBytes,
      sha256,
      stats,
    );
    compactedBytes = utf8ByteLength(JSON.stringify(compacted));
  }
  if (compactedBytes > policy.canonicalEventMaxBytes) {
    throw new RangeError(
      `provider runtime event cannot be compacted below ${policy.canonicalEventMaxBytes} bytes`,
    );
  }

  // The byte count is part of the encoded event, so changing it can change its
  // own decimal width. Converge on the exact serialized value instead of
  // reporting the pre-metadata estimate.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    compacted = {
      ...compacted,
      compaction: {
        ...compacted.compaction,
        compactedEncodedBytes: compactedBytes,
      },
    } as ProviderRuntimeEvent;
    const nextBytes = utf8ByteLength(JSON.stringify(compacted));
    if (nextBytes === compactedBytes) break;
    compactedBytes = nextBytes;
  }
  if (compactedBytes > policy.canonicalEventMaxBytes) {
    throw new RangeError(
      `provider runtime event compaction metadata exceeds ${policy.canonicalEventMaxBytes} bytes`,
    );
  }

  return {
    event: compacted,
    stats: {
      compacted: true,
      originalEncodedBytes,
      compactedEncodedBytes: compactedBytes,
      sha256,
      ...stats,
    },
  };
}
