import { Budget } from "./budget.ts";
import { requireRelay } from "./errors.ts";

/** Bounds RPC parser retention before returning encrypted stream credit.
 * Budget charges twice the unfinished UTF-8 length, covering its UTF-16 string.
 * Completed commands still pass the ordinary application schema/role checks.
 */
// Application bytes: eight bounded inline images plus prompt/metadata.
// This is separate from ciphertext transport retention.
export const RELAY_RPC_MESSAGE_BYTES = 128 * 1024 * 1024;

export class NdjsonGuard {
  private length = 0;
  private held: (() => void) | undefined;
  private active = true;
  readonly budget: Budget;
  readonly maximum: number;
  constructor(budget: Budget, maximum = 65_536) {
    requireRelay(
      Number.isSafeInteger(maximum) && maximum > 0 && maximum <= RELAY_RPC_MESSAGE_BYTES,
    );
    this.budget = budget;
    this.maximum = maximum;
  }
  admit(bytes: Uint8Array): void {
    requireRelay(this.active);
    let start = 0;
    try {
      for (let index = 0; index < bytes.byteLength; index++) {
        if (bytes[index] !== 10) continue;
        requireRelay(this.length + index - start <= this.maximum);
        this.release();
        start = index + 1;
      }
      const tail = bytes.byteLength - start;
      requireRelay(this.length + tail <= this.maximum);
      const nextLength = this.length + tail;
      this.release();
      if (nextLength > 0) {
        const release = this.budget.reserve(nextLength * 2);
        requireRelay(release, "BUSY");
        this.held = release;
        this.length = nextLength;
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  finish(): void {
    try {
      requireRelay(this.active && this.length === 0, "INCOMPLETE");
    } finally {
      this.close();
    }
  }
  private release(): void {
    this.held?.();
    this.held = undefined;
    this.length = 0;
  }
  close(): void {
    this.active = false;
    this.release();
  }
}
