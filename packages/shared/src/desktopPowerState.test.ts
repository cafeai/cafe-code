import { describe, expect, it } from "vitest";
import { makeDesktopPowerStateDecoder } from "./desktopPowerState.ts";

const frame = (sequence: number) =>
  JSON.stringify({ version: 1, sequence, enabled: true, workActive: true }) + "\n";
const bytes = (value: string) => new TextEncoder().encode(value);

describe("exact desktop backend power state", () => {
  it("retains fragmented frames and monotonic sequencing for one native owner", () => {
    const decoder = makeDesktopPowerStateDecoder();
    const first = frame(0);
    expect(decoder.push(bytes(first.slice(0, 7))).records).toEqual([]);
    expect(
      decoder.push(bytes(first.slice(7) + frame(1))).records.map((record) => record.sequence),
    ).toEqual([0, 1]);
    expect(decoder.end()).toBe(false);
  });
  it.each([
    frame(0),
    frame(-1),
    frame(Number.MAX_SAFE_INTEGER + 1),
    "{}\n",
    "x".repeat(193),
    '{"version":1,"sequence":1,"enabled":true,"workActive":"yes"}\n',
  ])("retires malformed, oversized, or replayed state without renewing the lease", (bad) => {
    const decoder = makeDesktopPowerStateDecoder();
    decoder.push(bytes(frame(0)));
    expect(decoder.push(bytes(bad)).invalid).toBe(true);
    expect(decoder.push(bytes(frame(2))).records).toEqual([]);
  });
  it("treats an incomplete final frame as loss of the owner", () => {
    const decoder = makeDesktopPowerStateDecoder();
    decoder.push(bytes('{"version":1'));
    expect(decoder.end()).toBe(true);
  });
});
