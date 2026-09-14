import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { DesktopAuthority, desktopTokenDigest, type DesktopBinding } from "./authority.ts";

function binding(threadId: string, desktopId = "desktop-a"): DesktopBinding {
  return {
    threadId: ThreadId.make(threadId),
    desktopId,
    incarnation: "one",
    connectionPath: "private",
    active: false,
    revoked: false,
    controllers: new Set(),
  };
}
describe("desktop root-turn authority", () => {
  it("rejects owner bearers and unknown desktop capabilities", () => {
    const authority = new DesktopAuthority();
    const token = randomBytes(32).toString("hex"),
      b = binding("root");
    authority.bindings.set(desktopTokenDigest(token), b);
    expect(authority.authorize(token, true)).toBe(b);
    expect(() => authority.authorize("Cafe owner JWT", true)).toThrow();
    expect(() => authority.authorize(token, false)).toThrow();
    expect(() => new DesktopAuthority().authorize(token, true)).toThrow();
  });
  it("pins one root turn and prevents idle or overlapping conversations from acting", async () => {
    const authority = new DesktopAuthority(),
      first = binding("first"),
      second = binding("second");
    expect(() => authority.requireTurn(first)).toThrow();
    authority.start(first);
    authority.requireTurn(first);
    expect(() => authority.start(second)).toThrow();
    expect(await authority.end(second, async () => {})).toBe(false);
    authority.requireTurn(first);
    expect(await authority.end(first, async () => {})).toBe(true);
    authority.start(second);
    authority.requireTurn(second);
    expect(() => authority.requireTurn(first)).toThrow();
  });
  it("releases all in-flight requests and cannot revive revoked authority", async () => {
    const authority = new DesktopAuthority(),
      b = binding("root"),
      controller = new AbortController();
    authority.start(b);
    b.controllers.add(controller);
    b.revoked = true;
    await authority.end(b, async () => {});
    expect(controller.signal.aborted).toBe(true);
    expect(b.controllers.size).toBe(0);
    expect(() => authority.start(b)).toThrow();
    expect(() => authority.requireTurn(b)).toThrow();
  });
  it("does not let an old binding release a newer desktop owner", async () => {
    const authority = new DesktopAuthority(),
      old = binding("root"),
      next = binding("root");
    authority.start(old);
    await authority.end(old, async () => {});
    authority.start(next);
    expect(
      await authority.end(old, async () => {
        throw new Error("must not cancel the new owner");
      }),
    ).toBe(false);
    authority.requireTurn(next);
  });
  it("blocks both conversations until the old input cancellation is acknowledged", async () => {
    const authority = new DesktopAuthority(),
      old = binding("old"),
      next = binding("next");
    authority.start(old);
    let finish!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ending = authority.end(old, () => cancelled);
    expect(
      authority.end(old, async () => {
        throw new Error("duplicate cancellation");
      }),
    ).toBe(ending);
    expect(() => authority.requireTurn(old)).toThrow();
    expect(() => authority.start(old)).toThrow();
    expect(() => authority.start(next)).toThrow();
    finish();
    await ending;
    authority.start(next);
    authority.requireTurn(next);
  });
  it("keeps an uncertain cancellation fenced until a cleanup retry succeeds", async () => {
    const authority = new DesktopAuthority(),
      old = binding("old"),
      next = binding("next");
    authority.start(old);
    await expect(
      authority.end(old, async () => {
        throw new Error("lost ACK");
      }),
    ).rejects.toThrow();
    expect(() => authority.start(next)).toThrow();
    expect(() => authority.start(old)).toThrow();
    expect(() => authority.requireTurn(old)).toThrow();
    await authority.end(old, async () => {});
    authority.start(next);
    authority.requireTurn(next);
  });
});
