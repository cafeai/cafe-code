// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import type { ThreadId } from "@cafecode/contracts";
import { desktopError } from "./nativeClient.ts";

export interface DesktopBinding {
  threadId: ThreadId;
  desktopId: string;
  incarnation: string;
  active: boolean;
  revoked: boolean;
  controllers: Set<AbortController>;
  connectionPath: string;
  observedEpoch?: number | undefined;
}
export const desktopTokenDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Root-turn authority is process local. Restarting the provider owner makes
 * all old capabilities invalid even while its durable desktop keeps running. */
export class DesktopAuthority {
  readonly bindings = new Map<string, DesktopBinding>();
  readonly active = new Map<string, DesktopBinding>();
  private readonly ending = new Map<DesktopBinding, Promise<boolean>>();
  // Selection belongs to the chat, so its current owner can change the next
  // turn's selection. start() still compares exact bindings to prevent two
  // provider sessions for the same chat from acquiring control concurrently.
  requireAvailable(threadId: ThreadId, desktopId: string) {
    const owner = this.active.get(desktopId);
    if (owner && owner.threadId !== threadId)
      throw desktopError(
        "busy",
        "Another conversation controls this desktop. Wait for its turn to finish or select another desktop.",
      );
  }
  start(binding: DesktopBinding) {
    if (binding.revoked)
      throw desktopError(
        "not_authorized",
        "Desktop access expired. Resume this conversation to reconnect.",
      );
    const owner = this.active.get(binding.desktopId);
    if (owner && (owner !== binding || !owner.active))
      throw desktopError(
        "busy",
        "Another conversation controls this desktop. Wait for its turn to finish or select another desktop.",
      );
    if (!binding.active) binding.observedEpoch = undefined;
    binding.active = true;
    this.active.set(binding.desktopId, binding);
  }
  end(binding: DesktopBinding, cancel: () => Promise<void>): Promise<boolean> {
    const pending = this.ending.get(binding);
    if (pending) return pending;
    const owned = this.active.get(binding.desktopId) === binding;
    binding.active = false;
    binding.observedEpoch = undefined;
    for (const controller of binding.controllers) controller.abort();
    binding.controllers.clear();
    if (!owned) return Promise.resolve(false);
    // Revoke tool admission immediately, but reserve the desktop until native
    // cancellation is acknowledged. A late unscoped cancel could otherwise
    // release the next conversation's keys or truncate its typing. Failed or
    // uncertain cancellation keeps this inactive reservation for a bounded
    // cleanup retry at the next turn admission; it never grants input access.
    const result = Promise.resolve()
      .then(cancel)
      .then(() => {
        if (this.active.get(binding.desktopId) === binding) this.active.delete(binding.desktopId);
        return true;
      })
      .finally(() => this.ending.delete(binding));
    this.ending.set(binding, result);
    return result;
  }
  authorize(token: string, enabled: boolean) {
    const binding = this.bindings.get(desktopTokenDigest(token));
    if (!enabled || !binding || binding.revoked)
      throw desktopError(
        "not_authorized",
        "Desktop Control is disabled or this session has expired.",
      );
    return binding;
  }
  requireTurn(binding: DesktopBinding) {
    if (binding.revoked || !binding.active || this.active.get(binding.desktopId) !== binding)
      throw desktopError(
        "not_authorized",
        "Desktop tools require an active turn in the attached conversation.",
      );
  }
}
