import { createHash, timingSafeEqual, type Hash } from "node:crypto";

const ASSISTANT_STREAM_HASH_ALGORITHM = "sha256";
const ASSISTANT_STREAM_HASH_ENCODING = "utf16le";

/**
 * Fixed-memory commitment to the exact assistant text observed from provider
 * deltas for one active message.
 *
 * Cafe cannot safely use its SQL projection to reconcile an `item.completed`
 * notification: projection workers intentionally run behind provider ingestion
 * and may contain only the first streamed chunk. Retaining another full copy of
 * every long-running assistant stream would create avoidable memory pressure,
 * so ingestion commits the UTF-16 code units to SHA-256 instead. UTF-16LE is
 * deliberate: JavaScript slicing and `String.length` use UTF-16 code units, and
 * hashing those code units keeps the commitment independent of provider delta
 * boundaries, including boundaries adjacent to surrogate pairs.
 */
export class AssistantStreamTextCommitment {
  readonly #hash: Hash;
  #codeUnitLength = 0;

  constructor() {
    this.#hash = createHash(ASSISTANT_STREAM_HASH_ALGORITHM);
  }

  append(delta: string): void {
    const nextLength = this.#codeUnitLength + delta.length;
    if (!Number.isSafeInteger(nextLength)) {
      throw new RangeError("Assistant stream text length exceeded the safe integer range");
    }

    this.#hash.update(delta, ASSISTANT_STREAM_HASH_ENCODING);
    this.#codeUnitLength = nextLength;
  }

  get codeUnitLength(): number {
    return this.#codeUnitLength;
  }

  /**
   * Returns true only when every streamed code unit is an exact prefix of the
   * completed provider item. A prefix match permits a provider completion to
   * recover an unstreamed suffix, while the cryptographic commitment prevents
   * a divergent or adversarial completion payload from replacing live output.
   */
  matchesPrefixOf(completedText: string): boolean {
    if (completedText.length < this.#codeUnitLength) {
      return false;
    }

    const observedDigest = this.#hash.copy().digest();
    const completedPrefixDigest = createHash(ASSISTANT_STREAM_HASH_ALGORITHM)
      .update(completedText.slice(0, this.#codeUnitLength), ASSISTANT_STREAM_HASH_ENCODING)
      .digest();
    return timingSafeEqual(observedDigest, completedPrefixDigest);
  }
}
