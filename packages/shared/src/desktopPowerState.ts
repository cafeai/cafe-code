/** Private, content-free state from the exact desktop backend's fd 5.
 * This conveys power-management intent only; it grants no provider authority. */
export const DESKTOP_POWER_STATE_FD = 5;
export const DESKTOP_POWER_STATE_MAX_BYTES = 192;
export const DESKTOP_POWER_STATE_LEASE_MS = 5_000;

export interface DesktopPowerState {
  readonly version: 1;
  readonly sequence: number;
  readonly enabled: boolean;
  readonly workActive: boolean;
}

export function isDesktopPowerState(value: unknown): value is DesktopPowerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record.version === 1 &&
    typeof record.sequence === "number" &&
    Number.isSafeInteger(record.sequence) &&
    record.sequence >= 0 &&
    typeof record.enabled === "boolean" &&
    typeof record.workActive === "boolean"
  );
}

/** Burn a malformed stream rather than allowing later frames to refresh it. */
export function makeDesktopPowerStateDecoder() {
  let pending: number[] = [];
  let invalid = false;
  let sequence = -1;
  return {
    push(bytes: Uint8Array): { readonly invalid: boolean; readonly records: DesktopPowerState[] } {
      const records: DesktopPowerState[] = [];
      if (invalid) return { invalid, records };
      for (const byte of bytes) {
        if (byte !== 10) {
          pending.push(byte);
          if (pending.length > DESKTOP_POWER_STATE_MAX_BYTES) {
            invalid = true;
            break;
          }
          continue;
        }
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(pending)),
          );
          if (!isDesktopPowerState(value) || value.sequence <= sequence) {
            invalid = true;
            break;
          }
          sequence = value.sequence;
          records.push(value);
          pending = [];
        } catch {
          invalid = true;
          break;
        }
      }
      if (invalid) {
        pending = [];
        records.length = 0;
      }
      return { invalid, records };
    },
    end(): boolean {
      const failed = invalid || pending.length > 0;
      invalid = true;
      pending = [];
      return failed;
    },
  };
}
