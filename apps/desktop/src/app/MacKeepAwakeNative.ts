// Fixed bundled native executable, exact ChildProcess lifetime and private pipes.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// Native no-follow executable admission is not general application path IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat } from "node:fs/promises";
import type { MacKeepAwakeState } from "@cafecode/contracts";
import type { MacKeepAwakeControllerOptions, MacPowerLease } from "./MacKeepAwakeController.ts";
import type { ClosedLidDisplayOwner } from "./DesktopPowerSaveBlocker.ts";

const reasons = new Set<MacKeepAwakeState["reason"]>([
  "lease-busy",
  "battery-low",
  "unknown-power",
  "thermal-limit",
  "native-refused",
  "cleanup-failed",
]);

export async function startMacPowerLease(
  candidates: readonly string[],
  input: Parameters<MacKeepAwakeControllerOptions["start"]>[0] & {
    readonly display?: ClosedLidDisplayOwner;
  },
): Promise<MacPowerLease | null> {
  let executable: string | undefined;
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        (info.mode & 0o111) !== 0
      ) {
        executable = candidate;
        break;
      }
    } catch {
      /* Missing fixed candidates are unavailable, never a PATH fallback. */
    }
    if (!input.current()) return null;
  }
  if (!executable || !input.current()) return null;
  const child = spawn(executable, [], {
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let closing = false;
  let closed = false;
  let ready = false;
  let resetRefused = false;
  let lidSequence: number | null = null;
  let displayEligible = false;
  let buffer = "";
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: (lease: MacPowerLease) => void;
  let rejectReady!: () => void;
  const admitted = new Promise<MacPowerLease>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = () => reject(new Error("Native keep-awake unavailable"));
  });
  let resolveClose!: () => void;
  const nativeClose = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const retire = () => {
    if (closing) return;
    closing = true;
    clearTimeout(readyTimer);
    child.stdin.end();
    // This retained child is the watchdog, never Cafe/provider/foreign PID.
    // Its worker independently retires on pipe loss if this fallback is used.
    if (!closed) {
      // This native child-close fallback must outlive cancellation of its
      // Effect owner. It controls only the retained Node ChildProcess handle.
      // @effect-diagnostics-next-line globalTimers:off
      closeTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 2_000);
    }
  };
  const fail = () => {
    input.state({ phase: "unavailable", reason: "native-protocol" });
    rejectReady();
    retire();
  };
  const lease: MacPowerLease = {
    renew: () => {
      if (closing || closed || !input.current()) {
        retire();
        return;
      }
      if (child.stdin.writableLength > 256) {
        fail();
        return;
      }
      let displayMaySleep = false;
      try {
        displayMaySleep = displayEligible && (input.display?.maySleep() ?? false);
      } catch {
        fail();
        return;
      }
      child.stdin.write(
        input.display
          ? `${JSON.stringify({
              command: "renew",
              lidSequence,
              displayMaySleep,
            })}\n`
          : '{"command":"renew"}\n',
      );
    },
    close: () => {
      retire();
      return nativeClose.then(() => {
        // Completion still joins the exact child. A kernel-refused reset is
        // retained even after Off retired status callbacks for this attempt.
        if (resetRefused) throw new Error("Native keep-awake cleanup unavailable");
      });
    },
  };
  child.stdin.on("error", () => {
    rejectReady();
    retire();
  });
  child.on("error", () => {
    rejectReady();
    retire();
  });
  child.once("close", () => {
    closed = true;
    if (!resetRefused) {
      try {
        input.display?.observe(null);
      } catch {
        /* Native close still owns completion. */
      }
    }
    clearTimeout(readyTimer);
    clearTimeout(closeTimer);
    rejectReady();
    resolveClose();
    if (!closing && ready) input.exited();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer += chunk.toString("utf8");
    if (buffer.length > 2048) {
      fail();
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.length > 256) {
        fail();
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        fail();
        return;
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        fail();
        return;
      }
      if (event.event === "ready" && Object.keys(event).length === 1 && !ready) {
        ready = true;
        clearTimeout(readyTimer);
        if (!input.current()) {
          rejectReady();
          retire();
          return;
        }
        resolveReady(lease);
      } else if (event.event === "active" && Object.keys(event).length === 1) {
        input.state({ phase: "active", reason: null });
      } else if (
        event.event === "lid" &&
        Object.keys(event).length === 4 &&
        input.display &&
        (event.closed === null || typeof event.closed === "boolean") &&
        (event.internalOnly === null || typeof event.internalOnly === "boolean") &&
        typeof event.sequence === "number" &&
        Number.isSafeInteger(event.sequence) &&
        event.sequence >= 0 &&
        (lidSequence === null || event.sequence > lidSequence)
      ) {
        lidSequence = event.sequence;
        displayEligible = event.closed === true && event.internalOnly === true;
        if (input.current() && !closing) {
          try {
            // Unknown topology withdraws new permission without relighting an
            // already sleeping panel. Known external displays restore the
            // ordinary display blocker; opening does too.
            if (event.closed === false || event.internalOnly === false)
              input.display.observe(false);
            else if (displayEligible) input.display.observe(true);
          } catch {
            fail();
            return;
          }
        }
      } else if (
        event.event === "paused" &&
        Object.keys(event).length === 2 &&
        reasons.has(event.reason as MacKeepAwakeState["reason"])
      ) {
        displayEligible = false;
        if (input.current() && !closing) {
          try {
            input.display?.observe(null);
          } catch {
            fail();
            return;
          }
        }
        input.state({ phase: "paused", reason: event.reason as MacKeepAwakeState["reason"] });
      } else if (
        event.event === "stopped" &&
        Object.keys(event).length === 2 &&
        typeof event.resetAccepted === "boolean"
      ) {
        if (!event.resetAccepted) {
          resetRefused = true;
          input.state({ phase: "unavailable", reason: "cleanup-failed" });
        }
      } else {
        fail();
        return;
      }
    }
  });
  // Promise/native-pipe readiness is retired by this same close owner, even
  // if an enclosing Effect fiber was cancelled while native spawn completed.
  // @effect-diagnostics-next-line globalTimers:off
  readyTimer = setTimeout(() => {
    rejectReady();
    retire();
  }, 5_000);
  try {
    return await admitted;
  } catch {
    retire();
    await nativeClose;
    return null;
  }
}
