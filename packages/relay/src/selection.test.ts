import { describe, expect, it } from "vitest";
import { selectHostRelays } from "./selection.ts";

describe("host-side relay latency policy", () => {
  const nodes = ["uk", "ca", "us"].map((id) => ({
    id,
    publicKey: id,
    url: "wss://" + id + ".example/v1/relay",
  }));
  const sample = (uk: number, ca: number, us: number, measuredAt = 1000) =>
    nodes.map((node, index) => ({ nodeId: node.id, rtt: [uk, ca, us][index]!, measuredAt }));
  it("chooses the two lowest host RTTs independently of viewer discovery geography", () => {
    expect(
      selectHostRelays(nodes, sample(140, 90, 25), undefined, 1000).map((node) => node.id),
    ).toEqual(["us", "ca"]);
    expect(
      selectHostRelays(nodes, sample(15, 90, 130), undefined, 1000).map((node) => node.id),
    ).toEqual(["uk", "ca"]);
  });
  it("holds a healthy primary for small changes and switches for a sustained material improvement", () => {
    expect(selectHostRelays(nodes, sample(94, 100, 130), "ca", 1000)[0]?.id).toBe("ca");
    expect(selectHostRelays(nodes, sample(80, 100, 130), "ca", 1000)[0]?.id).toBe("ca");
    expect(selectHostRelays(nodes, sample(60, 100, 130), "ca", 1000)[0]?.id).toBe("uk");
  });
  it("rejects stale, future and invalid observations without losing all candidates", () => {
    expect(
      selectHostRelays(nodes, sample(100, 20, 5, 1), undefined, 400_000).map((node) => node.id),
    ).toEqual(["uk", "ca"]);
    expect(
      selectHostRelays(nodes, sample(100, 20, 5, 2000), undefined, 1000).map((node) => node.id),
    ).toEqual(["uk", "ca"]);
    expect(selectHostRelays(nodes, sample(NaN, 20, -5), undefined, 1000)[0]?.id).toBe("ca");
  });
});
