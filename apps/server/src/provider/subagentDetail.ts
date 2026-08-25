import {
  THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_TOTAL_BYTES,
} from "@cafecode/contracts";

import type {
  ProviderSubagentDetail,
  ProviderSubagentDetailMessage,
} from "./Services/ProviderAdapter.ts";

/** Public provider text admitted to the shared detail canonicalizer. */
export interface ProviderSubagentPublicMessageInput {
  readonly role: "user" | "assistant";
  /** Multiple fragments are separated by one public newline without joining first. */
  readonly text: string | ReadonlyArray<string>;
}

interface MeasuredCandidate {
  readonly key: string;
  readonly sequence: number;
  readonly role: "user" | "assistant";
  readonly text: string | ReadonlyArray<string>;
  readonly sanitizedUtf8Bytes: number;
}

const RETAINED_HEAD_MESSAGES = 4;
const RETAINED_TAIL_MESSAGES = THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES - RETAINED_HEAD_MESSAGES;
const RETAINED_HEAD_BYTES = 48 * 1024;
const MIN_RETAINED_MESSAGE_BYTES = 512;

function isUnsafePublicCodePoint(codePoint: number): boolean {
  const isControl =
    (codePoint <= 0x1f && codePoint !== 0x0a) || (codePoint >= 0x7f && codePoint <= 0x9f);
  const isBidiControl =
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069);
  return isControl || isBidiControl;
}

function utf8ScalarBytes(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0xfffd;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Visit normalized Unicode scalars without first copying a provider-owned
 * message. A child transcript can be many megabytes long, so both sanitizing
 * and head/tail retention must stay O(1) in additional untrusted-text space.
 */
function forEachSanitizedScalar(
  source: string | ReadonlyArray<string>,
  visit: (scalar: string, utf8Bytes: number) => void,
): void {
  const fragments = typeof source === "string" ? [source] : source;
  for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
    if (fragmentIndex > 0) visit("\n", 1);
    const fragment = fragments[fragmentIndex] ?? "";
    let previousWasCarriageReturn = false;
    for (const providerScalar of fragment) {
      if (providerScalar === "\n" && previousWasCarriageReturn) {
        previousWasCarriageReturn = false;
        continue;
      }
      previousWasCarriageReturn = providerScalar === "\r";
      if (providerScalar === "\r") {
        visit("\n", 1);
        continue;
      }
      if (providerScalar === "\t") {
        visit("    ", 4);
        continue;
      }

      const providerCodePoint = providerScalar.codePointAt(0) ?? 0xfffd;
      if (isUnsafePublicCodePoint(providerCodePoint)) continue;

      // ECMAScript strings may contain isolated UTF-16 surrogates. Replace
      // those ill-formed code units explicitly so the public contract always
      // contains Unicode scalar values and byte accounting matches transport.
      const scalar =
        providerCodePoint >= 0xd800 && providerCodePoint <= 0xdfff ? "\ufffd" : providerScalar;
      visit(scalar, utf8ScalarBytes(scalar));
    }
  }
}

function measureSanitizedPublicText(source: string | ReadonlyArray<string>): {
  readonly utf8Bytes: number;
  readonly hasVisibleText: boolean;
} {
  let utf8Bytes = 0;
  let hasVisibleText = false;
  forEachSanitizedScalar(source, (scalar, scalarBytes) => {
    utf8Bytes += scalarBytes;
    if (!hasVisibleText && scalar.trim().length > 0) hasVisibleText = true;
  });
  return { utf8Bytes, hasVisibleText };
}

function retainSanitizedPublicText(
  candidate: MeasuredCandidate,
  retainedByteBudget: number,
): Pick<ProviderSubagentDetailMessage, "text" | "omission"> {
  const boundedBudget = Math.max(
    8,
    Math.min(THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES, Math.floor(retainedByteBudget)),
  );
  let completePrefix = "";
  let completePrefixBytes = 0;

  // User messages (especially the assignment) favor their beginning. Agent
  // updates favor their newest suffix, which is normally the useful state.
  const headBudget = Math.max(
    4,
    Math.floor(boundedBudget * (candidate.role === "user" ? 0.75 : 0.25)),
  );
  const tailBudget = Math.max(4, boundedBudget - headBudget);
  const tailScalars: Array<{ readonly scalar: string; readonly bytes: number }> = [];
  let tailStart = 0;
  let tailBytes = 0;

  forEachSanitizedScalar(candidate.text, (scalar, scalarBytes) => {
    if (completePrefixBytes + scalarBytes <= boundedBudget) {
      completePrefix += scalar;
      completePrefixBytes += scalarBytes;
    }

    tailScalars.push({ scalar, bytes: scalarBytes });
    tailBytes += scalarBytes;
    while (tailBytes > tailBudget && tailStart < tailScalars.length) {
      const removed = tailScalars[tailStart];
      tailStart += 1;
      if (removed) tailBytes -= removed.bytes;
    }
    // Compact the bounded deque periodically so a very long message cannot
    // leave one tiny retained tail backed by millions of discarded entries.
    if (tailStart >= 1024 && tailStart * 2 >= tailScalars.length) {
      tailScalars.splice(0, tailStart);
      tailStart = 0;
    }
  });

  if (candidate.sanitizedUtf8Bytes <= boundedBudget) {
    return { text: completePrefix };
  }

  let head = "";
  let headBytes = 0;
  for (const scalar of completePrefix) {
    const scalarBytes = utf8ScalarBytes(scalar);
    if (headBytes + scalarBytes > headBudget) break;
    head += scalar;
    headBytes += scalarBytes;
  }
  const tail = tailScalars
    .slice(tailStart)
    .map(({ scalar }) => scalar)
    .join("");
  const omittedUtf8Bytes = candidate.sanitizedUtf8Bytes - headBytes - tailBytes;
  return {
    text: head,
    omission: {
      tail,
      // A positive value is guaranteed because the full sanitized message is
      // larger than the retained budget and head/tail never overlap.
      omittedUtf8Bytes: Math.max(1, omittedUtf8Bytes),
    },
  };
}

function allocateRetainedGroup(
  candidates: ReadonlyArray<MeasuredCandidate>,
  totalByteBudget: number,
  newestFirst: boolean,
): ReadonlyArray<ProviderSubagentDetailMessage> {
  const ordered = newestFirst ? candidates.toReversed() : [...candidates];
  const retained: ProviderSubagentDetailMessage[] = [];
  let remainingBytes = totalByteBudget;
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    if (!candidate) continue;
    const candidatesAfter = ordered.length - index - 1;
    const reservedForLater = candidatesAfter * MIN_RETAINED_MESSAGE_BYTES;
    const candidateBudget = Math.min(
      THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES,
      Math.max(MIN_RETAINED_MESSAGE_BYTES, remainingBytes - reservedForLater),
    );
    const content = retainSanitizedPublicText(candidate, candidateBudget);
    const retainedBytes =
      new TextEncoder().encode(content.text).byteLength +
      (content.omission === undefined
        ? 0
        : new TextEncoder().encode(content.omission.tail).byteLength);
    remainingBytes -= retainedBytes;
    retained.push({ key: candidate.key, role: candidate.role, ...content });
  }
  return newestFirst ? retained.toReversed() : retained;
}

/**
 * Build one finite, provider-neutral public child transcript.
 *
 * The original assignment plus three early messages form a stable head. The
 * newest sixty public messages form the live tail. If final-assistant
 * preservation makes those windows disjoint, up to two typed gaps identify
 * the exact missing ranges. This keeps React keys and
 * renderer chronology stable as providers append updates while ensuring that
 * neither provider item ids nor hidden provider-native payloads cross the
 * boundary.
 */
export function canonicalizeProviderSubagentDetail(
  input: ReadonlyArray<ProviderSubagentPublicMessageInput>,
): ProviderSubagentDetail {
  let initialAssignmentIndex = -1;
  for (let index = 0; index < input.length; index += 1) {
    const candidate = input[index];
    if (candidate?.role !== "user") continue;
    if (measureSanitizedPublicText(candidate.text).hasVisibleText) {
      initialAssignmentIndex = index;
      break;
    }
  }

  // A malformed provider snapshot can omit its assignment. In that case keep
  // the public transcript from its first visible message instead of returning
  // an empty detail screen.
  const scanStart = initialAssignmentIndex >= 0 ? initialAssignmentIndex : 0;
  const head: MeasuredCandidate[] = [];
  const tail: MeasuredCandidate[] = [];
  let finalAssistant: MeasuredCandidate | undefined;
  let publicSequence = 0;

  for (let index = scanStart; index < input.length; index += 1) {
    const providerMessage = input[index];
    if (!providerMessage) continue;
    const measurement = measureSanitizedPublicText(providerMessage.text);
    if (!measurement.hasVisibleText) continue;
    const candidate: MeasuredCandidate = {
      key: `m${publicSequence.toString(36)}`,
      sequence: publicSequence,
      role: providerMessage.role,
      text: providerMessage.text,
      sanitizedUtf8Bytes: measurement.utf8Bytes,
    };
    publicSequence += 1;
    if (candidate.role === "assistant") finalAssistant = candidate;

    if (head.length < RETAINED_HEAD_MESSAGES) {
      head.push(candidate);
      continue;
    }
    tail.push(candidate);
    if (tail.length > RETAINED_TAIL_MESSAGES) {
      tail.shift();
    }
  }

  // Reserve the latest public assistant even if an adversarial or malformed
  // snapshot contains more than sixty user messages after it. Fill remaining
  // slots newest-first, then restore provider chronology. This can form two
  // disjoint gaps, which the plural typed gap contract represents exactly.
  const selectedByKey = new Map<string, MeasuredCandidate>();
  for (const candidate of head) selectedByKey.set(candidate.key, candidate);
  if (finalAssistant !== undefined) selectedByKey.set(finalAssistant.key, finalAssistant);
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (selectedByKey.size >= THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES) break;
    const candidate = tail[index];
    if (candidate) selectedByKey.set(candidate.key, candidate);
  }
  const selectedCandidates = [...selectedByKey.values()].toSorted(
    (left, right) => left.sequence - right.sequence,
  );
  const selectedHead = selectedCandidates.filter((candidate) => candidate.sequence < head.length);
  const selectedTail = selectedCandidates.filter((candidate) => candidate.sequence >= head.length);

  const headPotentialBytes = selectedHead.reduce(
    (total, candidate) =>
      total + Math.min(candidate.sanitizedUtf8Bytes, THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES),
    0,
  );
  const tailPotentialBytes = selectedTail.reduce(
    (total, candidate) =>
      total + Math.min(candidate.sanitizedUtf8Bytes, THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES),
    0,
  );
  const reservedHeadBytes = Math.min(headPotentialBytes, RETAINED_HEAD_BYTES);
  const tailByteBudget = Math.min(
    tailPotentialBytes,
    THREAD_TURN_SUBAGENT_DETAIL_MAX_TOTAL_BYTES - reservedHeadBytes,
  );
  // Give the head any capacity the tail cannot use. This matters for short
  // completed workers with one large assignment and one short final response:
  // reserving a fixed tail quota would otherwise truncate the assignment even
  // though the aggregate response still had ample room.
  const headByteBudget = Math.min(
    headPotentialBytes,
    THREAD_TURN_SUBAGENT_DETAIL_MAX_TOTAL_BYTES - tailByteBudget,
  );
  const retainedHead = allocateRetainedGroup(selectedHead, headByteBudget, false);
  const retainedTail = allocateRetainedGroup(selectedTail, tailByteBudget, true);
  const messages = [...retainedHead, ...retainedTail];
  const retainedKeys = new Set(messages.map((message) => message.key));
  const gaps: NonNullable<ProviderSubagentDetail["gaps"]>[number][] = [];
  let gapAfterMessageKey: string | null = null;
  let gapOmittedMessages = 0;
  let gapOmittedUtf8Bytes = 0;
  publicSequence = 0;

  // Rescan only lightweight public text measurements to account omitted bytes
  // exactly without retaining an unbounded prefix-sum table for a 16-hour
  // child. The selected output itself remains strictly bounded.
  for (let index = scanStart; index < input.length; index += 1) {
    const providerMessage = input[index];
    if (!providerMessage) continue;
    const measurement = measureSanitizedPublicText(providerMessage.text);
    if (!measurement.hasVisibleText) continue;
    const key = `m${publicSequence.toString(36)}`;
    publicSequence += 1;
    if (retainedKeys.has(key)) {
      if (gapOmittedMessages > 0) {
        gaps.push({
          afterMessageKey: gapAfterMessageKey,
          omittedMessages: gapOmittedMessages,
          omittedUtf8Bytes: gapOmittedUtf8Bytes,
        });
        gapOmittedMessages = 0;
        gapOmittedUtf8Bytes = 0;
      }
      gapAfterMessageKey = key;
    } else {
      gapOmittedMessages += 1;
      gapOmittedUtf8Bytes += measurement.utf8Bytes;
    }
  }
  if (gapOmittedMessages > 0) {
    gaps.push({
      afterMessageKey: gapAfterMessageKey,
      omittedMessages: gapOmittedMessages,
      omittedUtf8Bytes: gapOmittedUtf8Bytes,
    });
  }
  const hasContentOmission = messages.some((message) => message.omission !== undefined);
  return {
    messages,
    gaps,
    truncated: gaps.length > 0 || hasContentOmission,
  };
}
