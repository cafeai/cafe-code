import { Lifetime, epochNow } from "@cafecode/relay/lifetime";
import type { RelayHost } from "@cafecode/relay/host";
import { RelayError } from "@cafecode/relay/errors";

export interface ControlledRelayHost {
  readonly host: Pick<RelayHost, "active" | "stats" | "start" | "retire" | "close">;
}

/** One held application and latest intent. Off revokes synchronously, before
 * settings IO; replacement waits for exact old transports/solvers to close. */
export class RelayHostController<Entry extends ControlledRelayHost> {
  private readonly lifetime = new Lifetime();
  private revision = 0;
  private requested = false;
  private permitted = false;
  private started = false;
  private held:
    | { revision: number; lifetime: Lifetime; entries: Entry[]; closing?: Promise<void> }
    | undefined;
  private applying: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private failed = false;
  private retryAt = 0;
  private retries = 0;
  private everConnected = false;
  private readonly create: (lifetime: Lifetime) => Promise<Entry[]>;
  private readonly onStarted: ((entry: Entry) => void) | undefined;
  constructor(
    create: (lifetime: Lifetime) => Promise<Entry[]>,
    onStarted?: (entry: Entry) => void,
  ) {
    this.create = create;
    this.onStarted = onStarted;
  }
  get enabled() {
    return this.requested;
  }
  get entries(): readonly Entry[] {
    return this.held?.revision === this.revision && this.held.lifetime.active
      ? this.held.entries
      : [];
  }
  get phase(): "off" | "stopping" | "connecting" | "connected" | "reconnecting" | "unavailable" {
    if (!this.requested) return this.held ? "stopping" : "off";
    if (
      this.held?.revision === this.revision &&
      this.held.lifetime.active &&
      this.entries.some((entry) => entry.host.active && entry.host.stats().servingNodes.length > 0)
    ) {
      this.everConnected = true;
      return "connected";
    }
    return this.failed ? "unavailable" : this.everConnected ? "reconnecting" : "connecting";
  }
  request(enabled: boolean, permitted: boolean, replace = false): void {
    if (!this.lifetime.active) return;
    if (replace || this.requested !== enabled) {
      this.revision++;
      this.held?.lifetime.retire();
      for (const entry of this.held?.entries ?? []) entry.host.retire();
      this.retryAt = 0;
      this.retries = 0;
    }
    this.requested = enabled;
    this.permitted = permitted;
    this.wake();
  }
  start(): void {
    if (this.started || !this.lifetime.active) return;
    this.started = true;
    const tick = () =>
      this.lifetime.later(5_000, () => {
        this.wake();
        tick();
      });
    tick();
    this.wake();
  }
  private wake(): void {
    if (!this.started || !this.lifetime.active || this.applying) return;
    const revision = this.revision;
    const job = this.reconcile();
    this.applying = job;
    void job
      .catch(() => {
        // Failed native retirement keeps the exact owner held. Do not admit a
        // replacement on a requested stop or a rejected close acknowledgement.
        this.failed = true;
      })
      .finally(() => {
        if (this.applying === job) this.applying = undefined;
        if (this.lifetime.active && this.revision !== revision) this.wake();
      })
      .catch(() => {});
  }
  private async release(): Promise<void> {
    const held = this.held;
    if (!held) return;
    held.lifetime.retire();
    for (const entry of held.entries) entry.host.retire();
    await (held.closing ??= (async () => {
      const results = await Promise.allSettled(held.entries.map((entry) => entry.host.close()));
      await held.lifetime.close();
      if (results.some((result) => result.status === "rejected"))
        throw new RelayError("UNAVAILABLE");
    })());
    if (this.held === held) this.held = undefined;
  }
  private async reconcile(): Promise<void> {
    while (this.lifetime.active) {
      const revision = this.revision;
      if (
        this.held &&
        (this.held.revision !== revision || this.held.entries.some((entry) => !entry.host.active))
      ) {
        await this.release();
        continue;
      }
      if (!this.requested) {
        await this.release();
        return;
      }
      if (!this.permitted || this.held || epochNow() < this.retryAt) return;
      const held = { revision, lifetime: new Lifetime(), entries: [] as Entry[] };
      this.held = held;
      try {
        held.entries = await this.create(held.lifetime);
        if (held.entries.length === 0) throw new RelayError("UNAVAILABLE");
        if (!this.lifetime.active || !held.lifetime.active || revision !== this.revision) {
          await this.release();
          continue;
        }
        await Promise.allSettled(
          held.entries.map(async (entry) => {
            await entry.host.start();
            if (held.lifetime.active && entry.host.active && revision === this.revision)
              this.onStarted?.(entry);
          }),
        );
        if (revision === this.revision) {
          this.failed = false;
          this.retries = 0;
        }
      } catch {
        await this.release();
        if (revision === this.revision) {
          this.failed = this.requested;
          this.retryAt = epochNow() + Math.min(60_000, 5_000 * 2 ** Math.min(this.retries++, 4));
        }
      }
      if (revision === this.revision) return;
    }
  }
  close(): Promise<void> {
    this.lifetime.retire();
    this.requested = false;
    this.held?.lifetime.retire();
    for (const entry of this.held?.entries ?? []) entry.host.retire();
    return (this.closing ??= (async () => {
      await this.applying;
      await this.release();
      await this.lifetime.close();
    })());
  }
}
