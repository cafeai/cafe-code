import { z } from "zod";
import {
  actionReceiptSchema,
  appListSchema,
  installedAppSchema,
  isGlideAction,
  observationSchema,
} from "./protocol.ts";
import { GlideChild, type GlideNativeBridge } from "./runtime.ts";
import type { GlideActivityEvent } from "./activity.ts";

export interface GlideNativePeer {
  request(frame: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export class GlideNativeTransportError extends Error {}

const replySchema = z
  .object({
    id: z.number().int().positive(),
    result: z.unknown().optional(),
    error: z.string().max(2048).optional(),
  })
  .strict();

export function createGlideNativePeer(
  helperPath: string,
  apps: readonly string[],
  installations: readonly { bundleId: string; path: string }[] = [],
): GlideNativePeer {
  let sequence = 0;
  let pending:
    | { id: number; resolve(value: unknown): void; reject(error: Error): void }
    | undefined;
  let dead = false;
  let child: GlideChild | undefined;
  let stopping: Promise<void> | undefined;
  const fail = () => {
    dead = true;
    pending?.reject(
      new GlideNativeTransportError(
        "The native Glide host stopped. Inspect state before repeating an action.",
      ),
    );
    pending = undefined;
    if (child && !stopping) {
      stopping = child.stop();
      void stopping.catch(() => undefined);
    }
  };
  child = new GlideChild(
    helperPath,
    [
      "--input-mode",
      "background",
      ...apps.flatMap((app) => ["--allow-app", app]),
      ...installations.flatMap((app) => ["--allow-app-path", app.path]),
    ],
    (value) => {
      const reply = replySchema.parse(value);
      if (!pending || reply.id !== pending.id) throw new Error("Unexpected Glide native reply.");
      const owned = pending;
      pending = undefined;
      if (reply.error !== undefined) owned.reject(new Error(reply.error));
      else owned.resolve(reply.result);
    },
    fail,
  );
  return {
    request: async (frame) => {
      if (dead || pending)
        throw new GlideNativeTransportError("The native Glide host is unavailable.");
      const id = ++sequence;
      const result = new Promise<unknown>((resolve, reject) => {
        pending = { id, resolve, reject };
      });
      void result.catch(() => undefined);
      try {
        await child!.send({
          ...frame,
          id,
          ...(frame.method === "get_app_state" ? { visibilityVersion: 1 } : {}),
          ...(typeof frame.method === "string" && isGlideAction(frame.method)
            ? { receiptVersion: 1 }
            : {}),
        });
      } catch {
        fail();
      }
      return result;
    },
    close: async () => {
      fail();
      await stopping;
    },
  };
}

interface Session {
  readonly id: string;
  readonly authorize: () => Promise<{
    apps: readonly string[];
    desktop?: boolean;
    current: () => boolean;
  }>;
  epoch: number;
  closed: boolean;
  readonly observations: Map<string, number>;
  readonly activity?: (event: GlideActivityEvent) => Promise<void>;
}
interface Job {
  readonly session: Session;
  readonly epoch: number;
  readonly executionId: string;
  readonly reject: (error: Error) => void;
  cancelled: boolean;
}

/** One native lease and input lane per provider owner. Every queued operation
 * rechecks its live session, app grant, absolute deadline and observation host.
 * A cancelled queued session cannot terminate another session's active input. */
export class GlideNativeHost {
  private readonly sessions = new Map<string, Session>();
  private readonly jobs = new Set<Job>();
  private tail: Promise<unknown> = Promise.resolve();
  private retirement: Promise<void> = Promise.resolve();
  private peer: GlideNativePeer | undefined;
  private peerApps: readonly string[] = [];
  private peerAppPath: string | undefined;
  private generation = 0;
  private active: Job | undefined;
  private closed = false;
  private sequence = 0;

  private readonly factory: (
    apps: readonly string[],
    installations?: readonly { bundleId: string; path: string }[],
  ) => GlideNativePeer;
  private readonly desktopInventory: (() => Promise<unknown>) | undefined;
  private readonly resolveInstalled: ((selector: string) => Promise<unknown>) | undefined;
  constructor(
    factory: (
      apps: readonly string[],
      installations?: readonly { bundleId: string; path: string }[],
    ) => GlideNativePeer,
    desktopInventory?: () => Promise<unknown>,
    resolveInstalled?: (selector: string) => Promise<unknown>,
  ) {
    this.factory = factory;
    this.desktopInventory = desktopInventory;
    this.resolveInstalled = resolveInstalled;
  }

  attach(
    id: string,
    authorize: Session["authorize"],
    activity?: Session["activity"],
  ): GlideNativeBridge & { close(): Promise<void> } {
    if (
      this.closed ||
      this.sessions.has(id) ||
      this.sessions.size >= 32 ||
      !z.uuid().safeParse(id).success
    )
      throw new Error("Glide session cannot be admitted.");
    const session: Session = {
      id,
      authorize,
      epoch: 0,
      closed: false,
      observations: new Map(),
      ...(activity ? { activity } : {}),
    };
    this.sessions.set(id, session);
    const retire = async (executionId?: string) => {
      session.epoch++;
      session.observations.clear();
      for (const job of this.jobs) {
        if (
          job.session !== session ||
          (executionId !== undefined && job.executionId !== executionId)
        )
          continue;
        job.cancelled = true;
        job.reject(
          new Error("Glide execution was cancelled; earlier input may have taken effect."),
        );
      }
      if (
        this.active?.session === session &&
        (executionId === undefined || this.active.executionId === executionId)
      )
        await this.stopPeer();
      // Session-scoped snapshot retirement is serialized behind any foreign
      // operation. Revocation above already prevents fresh admission.
      const cleanup = this.tail.then(async () => {
        await this.retirement;
        if (this.peer)
          await this.peer.request({
            method: "retire_session",
            input: {},
            timeout_ms: 1000,
            sessionId: id,
          });
      });
      this.tail = cleanup.catch(() => this.stopPeer());
      void this.tail.catch(() => undefined);
      // A queued owner's cancellation is complete once its authority and
      // promises are retired. Snapshot cleanup may await a foreign operation;
      // it remains joined by the host lane, without delaying this Stop.
    };
    return {
      invoke: (request, owner) => {
        if (session.closed || this.closed || this.jobs.size >= 64)
          return Promise.reject(new Error("Glide session is closed or the native queue is full."));
        let resolve!: (value: unknown) => void;
        let reject!: (error: Error) => void;
        const result = new Promise<unknown>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const job: Job = {
          session,
          epoch: session.epoch,
          executionId: owner.executionId,
          reject,
          cancelled: false,
        };
        this.jobs.add(job);
        const operationId = ++this.sequence;
        const check = () => {
          if (
            this.closed ||
            session.closed ||
            job.cancelled ||
            session.epoch !== job.epoch ||
            owner.deadline <= performance.now()
          )
            throw new Error("Glide execution expired before native dispatch.");
        };
        const operation = this.tail.then(async () => {
          check();
          const grant = await session.authorize();
          check();
          if (!grant.current() || (!grant.desktop && !grant.apps.length) || grant.apps.length > 16)
            throw new Error("Glide access is disabled or its app grant expired.");
          await this.retirement;
          check();
          this.active = job;
          // Desktop permission is granted by the chat's explicit switch. The
          // native helper still receives an exact app allowlist, selected from
          // fresh trusted inventory for each operation, never a model path.
          const installationOperation =
            request.method === "resolve_app" || request.method === "launch_app";
          let desktopApp: z.infer<typeof installedAppSchema> | undefined;
          if (grant.desktop) {
            if (!this.desktopInventory) throw new Error("Desktop inventory is unavailable.");
            const inventory = appListSchema.parse(await this.desktopInventory());
            check();
            if (!grant.current()) throw new Error("Glide access was revoked.");
            if (request.method === "list_apps") return inventory;
            const requested = request.input.app;
            const matches = [
              ...new Map(
                inventory
                  .filter((app) => [app.name, app.path, app.bundleId].includes(requested))
                  .map((app) => [`${app.bundleId}\0${app.path}`, app]),
              ).values(),
            ];
            if (matches.length === 1) desktopApp = matches[0]!;
            else if (matches.length === 0 && installationOperation && this.resolveInstalled) {
              // Resolving metadata is inert. Only the fresh authenticated grant
              // may turn the exact returned installation into a helper allowlist.
              desktopApp = installedAppSchema.parse(await this.resolveInstalled(requested));
              check();
              if (!grant.current())
                throw new Error("Glide access was revoked during app resolution.");
            } else
              throw new Error(
                "Select one running application from glide.listApps(), or use resolveApp with an exact installed bundle ID or .app path.",
              );
            if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(desktopApp.bundleId))
              throw new Error("The running application has no valid bundle identity.");
          }
          const allowedApps = desktopApp ? [desktopApp.bundleId] : grant.apps;
          if (
            !this.peer ||
            allowedApps.some((app) => !this.peerApps.includes(app)) ||
            (desktopApp && this.peerAppPath !== desktopApp.path)
          ) {
            await this.stopPeer();
            check();
            if (!grant.current()) throw new Error("Glide access was revoked.");
            this.peer =
              installationOperation && desktopApp
                ? this.factory(allowedApps, [desktopApp])
                : this.factory(allowedApps);
            this.peerApps = [...allowedApps];
            this.peerAppPath = desktopApp?.path;
          }
          const dispatch = async (method: string, input: unknown) => {
            check();
            if (!grant.current())
              throw new Error("Glide access was revoked before native dispatch.");
            try {
              return await this.peer!.request({
                method,
                input,
                sessionId: id,
                timeout_ms: Math.max(1, Math.floor(owner.deadline - performance.now())),
              });
            } catch (error) {
              if (!["list_apps", "list_windows", "get_app_state", "resolve_app"].includes(method))
                session.observations.clear();
              if (error instanceof GlideNativeTransportError) await this.stopPeer();
              throw error;
            }
          };
          if (installationOperation) {
            const installed = installedAppSchema.parse(
              await dispatch("resolve_app", {
                app: desktopApp?.path ?? request.input.app,
              }),
            );
            check();
            if (
              !grant.current() ||
              (desktopApp
                ? installed.bundleId !== desktopApp.bundleId || installed.path !== desktopApp.path
                : !grant.apps.includes(installed.bundleId))
            )
              throw new Error("Installed application escaped its exact app grant.");
            if (request.method === "resolve_app") return installed;
            // A launch can create a new process/window generation. Neither old
            // observations nor a successful process receipt grant later input.
            for (const key of session.observations.keys())
              if (key.startsWith(`${installed.path}\0`)) session.observations.delete(key);
            await session.activity?.({
              phase: "start",
              operation: operationId,
              method: "launch_app",
              appName: installed.name,
              app: installed.path,
              screenshot: false,
            });
            return dispatch("launch_app", { app: installed.path });
          }
          const apps = appListSchema
            .parse(await dispatch("list_apps", {}))
            .filter((app) =>
              desktopApp
                ? app.bundleId === desktopApp.bundleId && app.path === desktopApp.path
                : grant.apps.includes(app.bundleId),
            );
          if (request.method === "list_apps") return apps;
          const requested = request.input.app;
          const matches = [
            ...new Map(
              apps
                .filter((app) => [app.name, app.path, app.bundleId].includes(requested))
                .map((app) => [`${app.bundleId}\0${app.path}`, app]),
            ).values(),
          ];
          if (matches.length !== 1)
            throw new Error(
              "Select one explicitly allowed running application from glide.listApps().",
            );
          const app = matches[0]!;
          const input = { ...request.input, app: app.path };
          const windowId = "windowId" in input ? input.windowId : undefined;
          if (request.method !== "get_app_state" && request.method !== "list_windows") {
            const key = `${app.path}\0${windowId ?? "primary"}`;
            if (session.observations.get(key) !== this.generation)
              throw new Error(
                "Obtain a fresh observation of this window before input; the native host or session changed.",
              );
          }
          if (request.method !== "list_windows") {
            // The native status item acknowledges the visible activity before
            // capture/input dispatch. Awaiting UI never bypasses the original
            // deadline, cancellation or exact grant recheck inside dispatch.
            await session.activity?.({
              phase: "start",
              operation: operationId,
              method: request.method,
              appName: app.name,
              app: app.path,
              ...(typeof windowId === "number" ? { windowId } : {}),
              screenshot:
                request.method === "get_app_state" && request.input.includeScreenshot !== false,
            });
          }
          const value = await dispatch(request.method, input);
          if (isGlideAction(request.method) && value !== null) {
            const outcome = actionReceiptSchema.safeParse(value);
            if (!outcome.success || outcome.data.method !== request.method) {
              session.observations.clear();
              throw new Error(
                "Native action receipt was invalid. Inspect fresh state before input.",
              );
            }
          }
          const receipt = actionReceiptSchema.safeParse(value);
          if (
            receipt.success &&
            (receipt.data.status === "uncertain" || receipt.data.status === "not-observed")
          )
            session.observations.clear();
          if (request.method === "restore_window") {
            for (const key of session.observations.keys())
              if (key.startsWith(`${app.path}\0`)) session.observations.delete(key);
          }
          if (request.method === "get_app_state") {
            const observed = observationSchema.parse(value);
            check();
            if (!grant.current()) throw new Error("Glide observation belongs to a revoked grant.");
            if (session.observations.size >= 16)
              session.observations.delete(session.observations.keys().next().value!);
            session.observations.set(`${app.path}\0${observed.windowId}`, this.generation);
            if (windowId === undefined)
              session.observations.set(`${app.path}\0primary`, this.generation);
            await session.activity?.({
              phase: "observation",
              operation: operationId,
              observation: observed,
            });
            check();
            if (!grant.current()) throw new Error("Glide observation belongs to a revoked grant.");
            const publicObservation = { ...observed };
            delete publicObservation.screenshotPreview;
            return publicObservation;
          }
          return value;
        });
        this.tail = operation
          .then(resolve, (error) =>
            reject(error instanceof Error ? error : new Error("Glide operation failed.")),
          )
          .finally(async () => {
            this.jobs.delete(job);
            if (this.active === job) this.active = undefined;
            await session
              .activity?.({ phase: "end", operation: operationId })
              .catch(() => undefined);
          });
        return result;
      },
      retire,
      close: async () => {
        session.closed = true;
        await retire();
        this.sessions.delete(id);
      },
    };
  }

  private stopPeer(): Promise<void> {
    const peer = this.peer;
    this.peer = undefined;
    this.peerApps = [];
    this.peerAppPath = undefined;
    this.generation++;
    this.retirement = Promise.all([this.retirement, peer?.close()]).then(() => undefined);
    // Cleanup uncertainty remains a sticky admission failure; observing its
    // rejection does not turn it into permission to create a competing host.
    void this.retirement.catch(() => undefined);
    return this.retirement;
  }

  async close() {
    this.closed = true;
    for (const session of this.sessions.values()) session.closed = true;
    for (const job of this.jobs) {
      job.cancelled = true;
      job.reject(new Error("Glide host closed."));
    }
    await this.stopPeer();
    await this.tail;
    this.sessions.clear();
  }
}
