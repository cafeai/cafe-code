import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { RelayError, requireRelay } from "./errors.ts";

const nativeClock = Effect.runSync(Clock.clockWith((clock) => Effect.succeed(clock)));
export const epochNow = (): number => nativeClock.currentTimeMillisUnsafe();
export const monotonicMillis = (): number =>
  Number(nativeClock.currentTimeNanosUnsafe() / 1_000_000n);

/**
 * A transport owns its scheduled effects. Retirement fences callbacks
 * synchronously; close joins the exact timer fibers' native cancellation.
 * This owner does not own or cancel a Cafe provider/application lifetime.
 */
export class Lifetime {
  private alive = true;
  private readonly controller = new AbortController();
  private readonly alarms = new Set<Fiber.Fiber<void>>();
  private readonly onDefect: () => void;
  private readonly clock: Clock.Clock | undefined;

  constructor(onDefect: () => void = () => {}, clock?: Clock.Clock) {
    this.onDefect = onDefect;
    this.clock = clock;
  }
  get active(): boolean {
    return this.alive;
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get timerCount(): number {
    return this.alarms.size;
  }

  later(milliseconds: number, action: () => void): () => void {
    requireRelay(this.alive, "UNAVAILABLE");
    requireRelay(
      Number.isFinite(milliseconds) && milliseconds >= 1 && milliseconds <= 2_147_483_647,
    );
    let admitted = true;
    const actionEffect = Effect.sleep(milliseconds).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (!this.alive || !admitted) return;
          admitted = false;
          try {
            action();
          } catch {
            // The callback belongs only to this transport. Never retain/coerce an
            // unknown callback exception or install a global exception swallow.
            this.retire();
            this.onDefect();
          }
        }),
      ),
    );
    const fiber = Effect.runFork(
      this.clock ? Effect.provideService(actionEffect, Clock.Clock, this.clock) : actionEffect,
    );
    this.alarms.add(fiber);
    fiber.addObserver(() => this.alarms.delete(fiber));
    return () => {
      admitted = false;
      fiber.interruptUnsafe();
    };
  }

  deadline(milliseconds: number): { readonly signal: AbortSignal; readonly cancel: () => void } {
    const controller = new AbortController();
    const abort = () => controller.abort(new RelayError("UNAVAILABLE"));
    this.signal.addEventListener("abort", abort, { once: true });
    const cancelAlarm = this.later(milliseconds, abort);
    return {
      signal: controller.signal,
      cancel: () => {
        cancelAlarm();
        this.signal.removeEventListener("abort", abort);
      },
    };
  }

  retire(): void {
    if (!this.alive) return;
    this.alive = false;
    this.controller.abort(new RelayError("UNAVAILABLE"));
    for (const fiber of this.alarms) fiber.interruptUnsafe();
  }

  async close(): Promise<void> {
    this.retire();
    await Effect.runPromise(Fiber.interruptAll([...this.alarms]));
    this.alarms.clear();
  }
}
