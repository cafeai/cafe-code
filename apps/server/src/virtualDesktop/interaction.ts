// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { VirtualDesktopError } from "@cafecode/contracts";
import { desktopError } from "./nativeClient.ts";
import {
  decodeAct,
  decodeDesktopInput,
  observeSchema,
  type DesktopAction,
  type DesktopRegion,
  type ObserveInput,
} from "./interactionSchema.ts";
import type { describeSwayTree } from "./swayState.ts";

type Result = Record<string, unknown>;
type Tree = ReturnType<typeof describeSwayTree>;
interface Observation {
  id: string;
  expires: number;
  epoch: number;
  width: number;
  height: number;
  region?: DesktopRegion | undefined;
  windowId?: number | undefined;
  windowRect?: DesktopRegion | undefined;
  hash: string;
  actionValidation: boolean;
  retained?: unknown;
}
export interface InteractionHost {
  request(body: Result, signal: AbortSignal): Promise<Result>;
  tree(signal: AbortSignal): Promise<Tree>;
  publish(frame: Result): Promise<unknown>;
  check(signal: AbortSignal): void;
  observed(epoch: number | undefined): void;
  epoch(): number | undefined;
  count(
    name: "captures" | "screenshots" | "screenshotPixels" | "unchangedCaptures" | "actions",
    amount?: number,
  ): void;
}
const stale = () =>
  desktopError(
    "operation_failed",
    "The screenshot reference expired or its geometry changed. Observe again before acting.",
  );
const regionOf = (window: Tree["windows"][number]): DesktopRegion => ({
  x: window.x,
  y: window.y,
  width: window.width,
  height: window.height,
});
const sameRegion = (a?: DesktopRegion, b?: DesktopRegion) =>
  JSON.stringify(a) === JSON.stringify(b);

/** One bounded, ephemeral reference per capability. It contains no image or
 * typed text and is independent of retained work-log screenshots (including
 * retention=0). The manager serializes stateful calls and invalidates this
 * reference at ownership/turn/display boundaries. */
export class DesktopInteraction {
  private last: Observation | undefined;
  private readonly host: InteractionHost;
  constructor(host: InteractionHost) {
    this.host = host;
  }
  invalidate() {
    this.last = undefined;
    this.host.observed(undefined);
  }
  private reference(id?: string) {
    const previous = this.last;
    if (
      !previous ||
      previous.expires < Date.now() ||
      previous.epoch !== this.host.epoch() ||
      (id !== undefined && id !== previous.id)
    )
      throw stale();
    return previous;
  }
  private guard(previous: Observation) {
    return {
      width: previous.width,
      height: previous.height,
      controlEpoch: previous.epoch,
      ...(previous.windowId === undefined
        ? {}
        : { windowId: previous.windowId, rect: previous.windowRect }),
    };
  }
  private async target(args: ObserveInput, signal: AbortSignal) {
    let region = args.region;
    let windowRect: DesktopRegion | undefined;
    if (args.windowId !== undefined) {
      const window = (await this.host.tree(signal)).windows.find(
        (window) => window.id === args.windowId,
      );
      if (!window || window.visible !== true || window.hiddenInScratchpad) throw stale();
      windowRect = regionOf(window);
      region = windowRect;
    }
    return { region, windowRect, windowId: args.windowId };
  }
  private async capture(args: ObserveInput, signal: AbortSignal, baseline?: Observation) {
    this.host.check(signal);
    const target = await this.target(args, signal);
    const sameTarget =
      baseline &&
      sameRegion(target.region, baseline.region) &&
      target.windowId === baseline.windowId;
    const status = target.region
      ? await this.host.request({ method: "status" }, signal)
      : undefined;
    if (target.region && status?.observationGuards !== true)
      throw desktopError(
        "unavailable",
        "Create a new desktop to enable guarded screenshot regions.",
      );
    const { region } = target;
    if (
      region &&
      (region.x + region.width > Number(status?.width) ||
        region.y + region.height > Number(status?.height))
    )
      throw stale();
    const frame = await this.host.request(
      {
        method: "observe",
        ...(region
          ? {
              region,
              observationGuard: {
                width: status?.width,
                height: status?.height,
                controlEpoch: status?.controlEpoch,
                ...(target.windowId === undefined
                  ? {}
                  : { windowId: target.windowId, rect: target.windowRect }),
              },
            }
          : {}),
        ...(sameTarget && !args.force
          ? {
              sinceHash: baseline.hash,
              sinceEpoch: baseline.epoch,
              sinceWidth: baseline.width,
              sinceHeight: baseline.height,
            }
          : {}),
      },
      signal,
    );
    this.host.check(signal);
    this.host.count("captures");
    const width = Number(frame.desktopWidth ?? frame.width),
      height = Number(frame.desktopHeight ?? frame.height);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(frame.controlEpoch)
    )
      throw stale();
    if (frame.unchanged === true) {
      // Never trust an unchanged flag without matching the exact runtime-owned
      // baseline, including ownership and desktop dimensions.
      if (
        !sameTarget ||
        frame.pixelHash !== baseline.hash ||
        frame.controlEpoch !== baseline.epoch ||
        width !== baseline.width ||
        height !== baseline.height
      )
        throw stale();
      this.host.count("unchangedCaptures");
      return { frame, previous: baseline, unchanged: true };
    }
    if (typeof frame.image !== "string") throw stale();
    return {
      frame,
      unchanged: false,
      previous: {
        id: randomUUID(),
        expires: Date.now() + 5 * 60_000,
        epoch: Number(frame.controlEpoch),
        width,
        height,
        ...target,
        hash: typeof frame.pixelHash === "string" ? frame.pixelHash : "",
        actionValidation: frame.actionValidation === true,
      } satisfies Observation,
    };
  }
  private async deliver(
    capture: Awaited<ReturnType<DesktopInteraction["capture"]>>,
    signal: AbortSignal,
  ): Promise<Result> {
    this.host.check(signal);
    const { frame, previous, unchanged } = capture;
    this.last = previous;
    this.host.observed(previous.epoch);
    if (unchanged)
      return { unchanged: true, observationId: previous.id, observation: previous.retained };
    const observation = await this.host.publish(frame);
    this.host.check(signal);
    previous.retained = observation;
    this.host.count("screenshots");
    this.host.count("screenshotPixels", Number(frame.width) * Number(frame.height));
    return {
      observationId: previous.id,
      width: frame.width,
      height: frame.height,
      humanControl: frame.humanControl,
      image: frame.image,
      observation,
      ...(previous.region
        ? {
            region: previous.region,
            desktopWidth: previous.width,
            desktopHeight: previous.height,
            ...(previous.windowId === undefined ? {} : { windowId: previous.windowId }),
          }
        : {}),
    };
  }
  async observe(value: unknown, signal: AbortSignal) {
    let args = decodeDesktopInput(observeSchema, value);
    const baseline = args.since ? this.reference(args.since) : undefined;
    // A conditional read keeps the previous crop unless the caller explicitly
    // chooses another target. An empty/force-only observe recovers full-screen.
    if (baseline && !args.region && args.windowId === undefined)
      args = {
        ...args,
        ...(baseline.windowId === undefined
          ? { region: baseline.region }
          : { windowId: baseline.windowId }),
      };
    return this.deliver(await this.capture(args, signal, baseline), signal);
  }
  private mapAction(action: DesktopAction, previous: Observation): DesktopAction {
    if (!("x" in action)) return action;
    const region = previous.region ?? {
      x: 0,
      y: 0,
      width: previous.width,
      height: previous.height,
    };
    if (
      action.x >= region.width ||
      action.y >= region.height ||
      (action.kind === "drag" && (action.toX >= region.width || action.toY >= region.height))
    )
      throw stale();
    return {
      ...action,
      x: action.x + region.x,
      y: action.y + region.y,
      ...(action.kind === "drag" ? { toX: action.toX + region.x, toY: action.toY + region.y } : {}),
    };
  }
  async act(value: unknown, signal: AbortSignal): Promise<Result> {
    const args = decodeAct(value);
    const previous = this.reference(args.observationId);
    if (previous.region && args.observationId === undefined)
      throw desktopError(
        "invalid_request",
        "Include the cropped screenshot's observationId when acting, or observe the full desktop first.",
      );
    // Validate every step/coordinate before any input, then let the worker
    // validate symbols against its real keymap. No preflight performs input.
    const actions = args.actions.map((action) => this.mapAction(action, previous));
    if (actions.length > 1 && !previous.actionValidation)
      throw desktopError("unavailable", "Create a new desktop to enable action sequences.");
    // Single actions already validate in the worker; avoid adding a status
    // subprocess to every click. A sequence needs one preflight for all keys.
    if (actions.length > 1)
      await this.host.request(
        {
          method: "validate_actions",
          actions,
          controlEpoch: previous.epoch,
          observationGuard: this.guard(previous),
        },
        signal,
      );
    let completed = 0;
    let dispatched = false;
    const deadline = AbortSignal.timeout(45_000);
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      for (const action of actions) {
        this.host.check(bounded);
        dispatched = true;
        await this.host.request(
          {
            ...action,
            method: "act",
            controlEpoch: previous.epoch,
            observationGuard: this.guard(previous),
          },
          bounded,
        );
        completed++;
        dispatched = false;
        this.host.count("actions");
      }
    } catch (error) {
      this.invalidate();
      // Even a failure ACK can arrive after some input in this step. Never
      // roll back or replay: the caller must inspect before continuing.
      return {
        success: false,
        completed,
        ...(dispatched ? { uncertainStep: completed + 1 } : {}),
        code: error instanceof VirtualDesktopError ? error.code : "operation_failed",
        observeBeforeRetry: true,
      };
    }
    const result: Result = { ok: true, ...(actions.length > 1 ? { completed } : {}) };
    const captureArgs =
      previous.windowId === undefined
        ? { region: previous.region }
        : { windowId: previous.windowId };
    let capture: Awaited<ReturnType<DesktopInteraction["capture"]>> | undefined;
    try {
      if (args.waitFor) {
        const end = Date.now() + args.waitFor.timeoutMs;
        const timeout = AbortSignal.timeout(args.waitFor.timeoutMs);
        const waiting = AbortSignal.any([bounded, timeout]);
        let met = false;
        try {
          while (Date.now() < end) {
            this.host.check(waiting);
            if (args.waitFor.type === "screen_change") {
              capture = await this.capture(captureArgs, waiting, previous);
              met = !capture.unchanged;
            } else {
              const { windows } = await this.host.tree(waiting);
              met = windows.some(
                (window) =>
                  window.visible === true &&
                  (args.waitFor?.type !== "window" ||
                    ((args.waitFor.windowId === undefined || window.id === args.waitFor.windowId) &&
                      (args.waitFor.appId === undefined || window.appId === args.waitFor.appId))),
              );
            }
            if (met) break;
            await delay(Math.min(350, Math.max(0, end - Date.now())), undefined, {
              signal: waiting,
            });
          }
        } catch (error) {
          if (!timeout.aborted || bounded.aborted) throw error;
        }
        result.wait = met ? "condition_met" : "timed_out";
      }
      if (args.observeAfter !== "none") {
        // Reuse the last local wait capture instead of encoding twice. An
        // explicit always request must still include an unchanged image.
        if (!capture || (args.observeAfter === "always" && capture.unchanged))
          capture = await this.capture(
            { ...captureArgs, force: args.observeAfter === "always" },
            bounded,
            previous,
          );
        Object.assign(result, await this.deliver(capture, bounded));
      }
      return result;
    } catch {
      this.invalidate();
      return { ok: true, completed, observationUnavailable: true, observeBeforeActing: true };
    }
  }
}

export function compactWindows(tree: Tree) {
  return {
    windows: tree.windows.map(
      ({
        id,
        title,
        appId,
        parentId,
        workspace,
        focused,
        visible,
        x,
        y,
        width,
        height,
        hiddenInScratchpad,
      }) => ({
        id,
        title,
        appId,
        parentId,
        workspace,
        focused,
        visible,
        x,
        y,
        width,
        height,
        ...(hiddenInScratchpad ? { hiddenInScratchpad } : {}),
      }),
    ),
    truncated: tree.truncated,
  };
}
