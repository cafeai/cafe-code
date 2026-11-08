import { z } from "zod";
import { GlideChild } from "./runtime.ts";
import type { GlideTraySnapshot } from "./activity.ts";

export const glideTrayEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["stop-all", "settings"]) }).strict(),
  z.object({ type: z.enum(["stop-chat", "open-chat"]), owner: z.uuid() }).strict(),
]);
export type GlideTrayEvent = z.infer<typeof glideTrayEventSchema>;
export interface GlideTrayHost {
  publish(snapshot: GlideTraySnapshot): Promise<void>;
  close(): Promise<void>;
}

/** This exact child owns only a status item, never input. One in-flight frame
 * plus one coalesced snapshot bounds image copies and keeps Stop on the private
 * incoming lane even while publishing. Native ACK precedes capture admission. */
export function createGlideTrayHost(
  helperPath: string,
  onEvent: (event: GlideTrayEvent) => void,
  onFailure: () => void,
): GlideTrayHost {
  let closed = false,
    ready = false,
    sequence = 0;
  let pending: { id: number; resolve(): void; reject(error: Error): void } | undefined;
  let latest:
    | {
        snapshot: GlideTraySnapshot;
        waiters: Array<{ resolve(): void; reject(error: Error): void }>;
      }
    | undefined;
  let retiring: Promise<void> | undefined;
  let child: GlideChild | undefined;
  const unavailable = () =>
    new Error("Computer use status is unavailable. Access has been stopped.");
  // These native protocol timers bound the exact child's ready/ACK lifetime;
  // they never schedule capture, refresh a grant or retry an action.
  // @effect-diagnostics-next-line globalTimers:off
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => fail(), 10_000);
  const fail = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    pending?.reject(unavailable());
    pending = undefined;
    for (const waiter of latest?.waiters ?? []) waiter.reject(unavailable());
    latest = undefined;
    retiring = child?.stop();
    void retiring?.catch(() => undefined);
    onFailure();
  };
  const pump = () => {
    if (!ready || closed || pending || !latest) return;
    const batch = latest;
    latest = undefined;
    const id = ++sequence;
    pending = {
      id,
      resolve: () => batch.waiters.forEach((waiter) => waiter.resolve()),
      reject: (error) => batch.waiters.forEach((waiter) => waiter.reject(error)),
    };
    // Same exact-child ACK deadline; no action replay on expiry.
    // @effect-diagnostics-next-line globalTimers:off
    timer = setTimeout(fail, 5000);
    void child!.send({ id, snapshot: batch.snapshot }).catch(fail);
  };
  try {
    child = new GlideChild(
      helperPath,
      ["--tray"],
      (raw) => {
        if (closed) return;
        const init = z
          .object({ type: z.literal("ready") })
          .strict()
          .safeParse(raw);
        if (init.success) {
          if (ready) throw unavailable();
          ready = true;
          clearTimeout(timer);
          pump();
          return;
        }
        const ack = z
          .object({ type: z.literal("applied"), id: z.number().int().positive() })
          .strict()
          .safeParse(raw);
        if (ack.success) {
          if (pending?.id !== ack.data.id) throw unavailable();
          clearTimeout(timer);
          const batch = pending;
          pending = undefined;
          batch.resolve();
          pump();
          return;
        }
        if (!ready) throw unavailable();
        onEvent(glideTrayEventSchema.parse(raw));
      },
      fail,
    );
  } catch {
    fail();
    throw unavailable();
  }
  return {
    publish: (snapshot) => {
      if (closed || (latest?.waiters.length ?? 0) >= 128) return Promise.reject(unavailable());
      const result = new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject };
        if (latest) {
          latest.snapshot = snapshot;
          latest.waiters.push(waiter);
        } else latest = { snapshot, waiters: [waiter] };
      });
      pump();
      return result;
    },
    close: async () => {
      closed = true;
      clearTimeout(timer);
      pending?.reject(unavailable());
      pending = undefined;
      for (const waiter of latest?.waiters ?? []) waiter.reject(unavailable());
      latest = undefined;
      retiring ??= child?.stop();
      await retiring;
    },
  };
}
