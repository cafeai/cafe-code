import type { LegendListRef } from "@legendapp/list/react";
import { visualizationGeometry } from "./visualizationGeometry";

type VisualizationTimelineList = Pick<LegendListRef, "getScrollableNode" | "scrollToOffset">;

function currentScroll(list: VisualizationTimelineList): HTMLElement | null {
  const node: unknown = list.getScrollableNode();
  return node instanceof HTMLElement && node.isConnected ? node : null;
}

/**
 * Exact renderer-owned list coordination, not a command channel exposed to a
 * guest. The list's public imperative API cancels an older deferred imperative
 * token, whereas a bare DOM scroll cannot cancel that queued end target.
 *
 * One partially visible chart may need special preservation during its own
 * admitted resize: the library otherwise anchors a later fully visible row.
 * Keep just one weak chart handle, one observer and one coalesced frame. Never
 * disable ordinary list anchoring or retain detached/private card descendants.
 */
export function createVisualizationTimelineScrollOwner({
  readList,
  following,
}: {
  readList: () => VisualizationTimelineList | null;
  following: () => boolean;
}) {
  type Pending = {
    list: VisualizationTimelineList;
    scroll: HTMLElement;
    anchor: WeakRef<HTMLElement>;
    top: number;
    expectedHeight: number;
    ready: boolean;
    observer: ResizeObserver;
    frame: number;
    version: number;
    corrections: number;
  };
  type Command = {
    list: VisualizationTimelineList;
    scroll: HTMLElement;
    target: number;
    observingInput: boolean;
    awaitingInput: boolean;
  };
  let closed = false;
  let pending: Pending | null = null;
  // Resize ownership and deferred imperative ownership have different ends.
  // Releasing the weak chart/observer must not lose the latest API token that
  // can still execute after fresh DOM input. Retain only one command snapshot.
  let command: Command | null = null;
  const exact = (job: Pending) =>
    !closed && pending === job && readList() === job.list && currentScroll(job.list) === job.scroll;
  const disconnect = (job: Pending) => {
    job.observer.disconnect();
    if (job.frame) cancelAnimationFrame(job.frame);
    job.frame = 0;
  };
  const release = (job: Pending) => {
    disconnect(job);
    if (pending === job) pending = null;
  };
  const exactCommand = (current: Command) =>
    !closed &&
    command === current &&
    readList() === current.list &&
    currentScroll(current.list) === current.scroll;
  const synchronize = (
    list: VisualizationTimelineList,
    scroll: HTMLElement,
    offset: number,
    job?: Pending,
    observingInput = false,
  ) => {
    if (closed || readList() !== list || currentScroll(list) !== scroll || !Number.isFinite(offset))
      return;
    const current: Command = { list, scroll, target: offset, observingInput, awaitingInput: false };
    command = current;
    const version = job?.version;
    // Observe the real physical position, never add the gesture twice. Each
    // supported API call supersedes the prior deferred token immediately. Its
    // own finite settle policy is unchanged; no new polling/timer is introduced.
    try {
      const settled = () => {
        if (command !== current || current.awaitingInput) return;
        command = null;
        if (job && pending === job && job.version === version) release(job);
      };
      void list.scrollToOffset({ offset, animated: false }).then(settled, settled);
    } catch {
      // Renderer layout cleanup must not delay revoking a native lease if the
      // list has already been torn down. Never retry a failed imperative call.
      if (command === current) command = null;
      if (job && pending === job) release(job);
    }
  };
  const cancel = (job: Pending) => {
    if (exact(job) && command && exactCommand(command))
      // A lease/scope loss is not permission for a queued old chart correction
      // to move its chat later. Supersede with the current exact owner position.
      synchronize(job.list, job.scroll, job.scroll.scrollTop);
    release(job);
  };
  const correct = (job: Pending) => {
    if (!exact(job)) {
      release(job);
      return;
    }
    const anchor = job.anchor.deref();
    if (
      !anchor?.isConnected ||
      !job.scroll.contains(anchor) ||
      following() ||
      !visualizationGeometry(anchor)
    ) {
      cancel(job);
      return;
    }
    if (!job.ready) return;
    const viewport = job.scroll.getBoundingClientRect();
    const delta = anchor.getBoundingClientRect().top - viewport.top - job.top;
    if (!Number.isFinite(delta) || Math.abs(delta) > 2000 || job.corrections >= 8) {
      cancel(job);
      return;
    }
    const changed = Math.abs(delta) > 0.5;
    if (changed) {
      job.corrections += 1;
      job.scroll.scrollBy({ top: delta, behavior: "instant" });
    }
    if (changed || command?.target !== job.scroll.scrollTop)
      synchronize(job.list, job.scroll, job.scroll.scrollTop, job);
  };
  return {
    /** Return true only after this exact list applies the vertical input once. */
    scroll(deltaY: number, beforeScroll?: () => void): boolean {
      if (closed || !Number.isFinite(deltaY) || Math.abs(deltaY) > 2048) return false;
      const list = readList();
      const scroll = list && currentScroll(list);
      if (!list || !scroll) return false;
      const target = scroll.scrollTop + deltaY;
      // A queued transcript update may commit while entering review. Capture
      // the actual gesture origin before that synchronous commit so its layout
      // anchoring cannot silently consume a native delta, including rapid ones.
      beforeScroll?.();
      if (closed || readList() !== list || currentScroll(list) !== scroll) return false;
      if (pending) release(pending);
      scroll.scrollBy({ top: target - scroll.scrollTop, behavior: "instant" });
      // Native input is immediate and cumulative, including repeated deltas
      // during a deferred list measurement. The API only synchronizes the
      // observed absolute position and revokes the stale end-target token.
      synchronize(list, scroll, scroll.scrollTop);
      return true;
    },
    preserve(anchor: HTMLElement, height: number): (() => void) | undefined {
      if (closed || following() || !Number.isInteger(height) || height < 80 || height > 2000)
        return;
      const list = readList();
      const scroll = list && currentScroll(list);
      if (!list || !scroll || !anchor.isConnected || !scroll.contains(anchor)) return;
      if (pending && exact(pending) && pending.anchor.deref() === anchor) {
        if (pending.expectedHeight !== height) {
          pending.ready = false;
          // A prior absolute sync may settle before the next real size sample.
          // Its completion must not dispose this newly admitted pending resize.
          pending.version += 1;
        }
        pending.expectedHeight = height;
        const retained = pending;
        return () => cancel(retained);
      }
      const viewport = scroll.getBoundingClientRect();
      const bounds = anchor.getBoundingClientRect();
      // Ordinary fully visible/offscreen charts retain ordinary MVCP. Only the
      // actual partly-visible chart being read above the viewport gets a lock.
      if (
        bounds.top >= viewport.top ||
        bounds.bottom <= viewport.top + 32 ||
        !visualizationGeometry(anchor)
      )
        return;
      if (pending) cancel(pending);
      const job: Pending = {
        list,
        scroll,
        anchor: new WeakRef(anchor),
        top: bounds.top - viewport.top,
        expectedHeight: height,
        ready: false,
        observer: new ResizeObserver(() => {
          if (!exact(job)) return;
          const current = job.anchor.deref();
          if (
            !current ||
            Math.abs(current.getBoundingClientRect().height - job.expectedHeight) > 0.5
          )
            return;
          job.ready = true;
          if (!job.frame)
            job.frame = requestAnimationFrame(() => {
              job.frame = 0;
              correct(job);
            });
        }),
        frame: 0,
        version: 0,
        corrections: 0,
      };
      pending = job;
      try {
        job.observer.observe(anchor);
      } catch {
        release(job);
        return;
      }
      return () => cancel(job);
    },
    /** Fresh intent revokes restoration, but waits for its actual scroll event. */
    interrupt() {
      if (command && exactCommand(command)) {
        command.observingInput = true;
        command.awaitingInput = true;
      }
      if (pending) release(pending);
    },
    observeScroll() {
      if (command && exactCommand(command) && command.observingInput) {
        // Wait for the actual new physical position, not a same-position event
        // caused by the old API command. An older completion cannot erase this
        // observation before the default wheel/touch/key action takes effect.
        if (command.target !== command.scroll.scrollTop)
          // Keyboard/wheel default scrolling can produce several real physical
          // positions. Continue replacing the same latest token until its own
          // settled completion, not merely the first pixel of the gesture.
          synchronize(command.list, command.scroll, command.scroll.scrollTop, undefined, true);
        return;
      }
      if (pending) correct(pending);
    },
    close() {
      if (pending) cancel(pending);
      else if (command && exactCommand(command))
        synchronize(command.list, command.scroll, command.scroll.scrollTop);
      closed = true;
      command = null;
    },
  };
}
