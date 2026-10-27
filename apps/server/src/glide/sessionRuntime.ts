// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  GlideError,
  type GlideControlResult,
  type ThreadId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGlidePolicyStore } from "./policyStore.ts";
import { ServerConfig } from "../config.ts";
import { makeSessionMcpFiles, type SessionMcpFiles } from "../mcp/sessionFiles.ts";
import { createGlideNativePeer, GlideNativeHost } from "./nativeHost.ts";
import { GlideActivity } from "./activity.ts";
import { glideTrayPresentation } from "./trayPresentation.ts";
import type { UiLocale } from "@cafecode/shared/i18n";
import { createGlideTrayHost, type GlideTrayHost, type GlideTrayEvent } from "./tray.ts";
import {
  GlideExecutionError,
  glideExecutionFailure,
  GlideRuntime,
  validateGlideHelper,
  glideChildEnvironment,
} from "./runtime.ts";
import {
  installedAppSchema,
  jsInputSchema,
  GLIDE_FRAME_BYTES,
  type CellResult,
} from "./protocol.ts";

export const GLIDE_OWNER_PATH = "/glide/session/operation";
export interface GlideSessionBinding {
  readonly name: string;
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  activate(): Promise<void>;
  cancel(): Promise<void>;
  resume(): void;
  /** Exact adapter-owned root lifecycle, separate from a persistent session. */
  observeTurn?(event: Pick<ProviderRuntimeEvent, "type" | "threadId" | "turnId">): void;
  dispose(): Promise<void>;
}
export interface GlideSessionBroker {
  bind(input: {
    threadId: ThreadId;
    providerInstanceId: ProviderInstanceId;
    provider: "codex" | "claudeAgent" | "grok";
    runtimeMode: string;
  }): Promise<GlideSessionBinding | undefined>;
}
type Policy = { enabled: boolean; apps: readonly string[]; fullAccess: boolean; desktop?: boolean };
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const glideOwnerOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("initialize-thread"),
      threadId: z.string().min(1).max(200),
      stopRevision: z
        .string()
        .regex(/^(0|[1-9][0-9]{0,15})$/)
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("retire-thread"), threadId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("catalog"), token: tokenSchema }).strict(),
  z.object({ kind: z.literal("execute"), token: tokenSchema, input: jsInputSchema }).strict(),
  z.object({ kind: z.literal("reset"), token: tokenSchema }).strict(),
  z
    .object({
      kind: z.literal("control"),
      input: z.discriminatedUnion("action", [
        z
          .object({
            action: z.literal("set-enabled"),
            threadId: z.string().min(1).max(200),
            enabled: z.boolean(),
          })
          .strict(),
        z
          .object({
            action: z.enum([
              "status",
              "activity",
              "open-accessibility",
              "open-screen-recording",
              "reveal-host-app",
            ]),
            threadId: z.string().min(1).max(200).optional(),
          })
          .strict(),
        z.object({ action: z.literal("stop"), threadId: z.string().min(1).max(200) }).strict(),
        z.object({ action: z.literal("stop-all") }).strict(),
        z
          .object({
            action: z.literal("presentation"),
            theme: z.enum(["dark", "light"]),
            locale: z.enum(["en", "ja", "ko"]),
            accent: z
              .string()
              .max(128)
              .regex(/^(#[a-fA-F0-9]{6}|oklch\([0-9.\s%]+\))$/)
              .optional(),
          })
          .strict(),
        z.object({ action: z.literal("ack-navigation"), id: z.string().min(1).max(64) }).strict(),
        z
          .object({
            action: z.literal("configure"),
            threadId: z.string().min(1).max(200),
            enabled: z.boolean(),
            apps: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/)).max(16),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type GlideOwnerOperation = z.infer<typeof glideOwnerOperationSchema>;
const denied = () =>
  new GlideError({
    message:
      "Glide is unavailable or this chat's permission expired. Check Glide in the chat controls.",
  });
const digest = (token: string) =>
  createHash("sha256").update("cafe-glide-v1\0").update(token).digest("hex");
let broker: GlideSessionBroker | undefined;
let ownerOperation:
  | ((operation: GlideOwnerOperation, signal?: AbortSignal) => Promise<unknown>)
  | undefined;
export const readGlideSessionBroker = () => broker;
export function installGlideSessionRuntime(
  value: GlideSessionBroker & {
    operation(operation: GlideOwnerOperation, signal?: AbortSignal): Promise<unknown>;
  },
) {
  broker = value;
  ownerOperation = value.operation;
  return () => {
    if (broker === value) broker = undefined;
    if (ownerOperation === value.operation) ownerOperation = undefined;
  };
}
export async function dispatchGlideOwnerOperation(
  operation: GlideOwnerOperation,
  signal?: AbortSignal,
) {
  if (!ownerOperation) {
    if (operation.kind === "retire-thread") return null;
    throw denied();
  }
  return ownerOperation(glideOwnerOperationSchema.parse(operation), signal);
}

export async function resolveGlideHelper(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const candidates = [
    resolve(dirname(process.execPath), "../Resources/mac-glide"),
    fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? `../../../desktop/native/build/${process.arch}/mac-glide`
          : `../../desktop/native/build/${process.arch}/mac-glide`,
        import.meta.url,
      ),
    ),
  ];
  for (const candidate of candidates) {
    try {
      return await validateGlideHelper(candidate);
    } catch {
      /* Only fixed source/bundle assets are candidates. */
    }
  }
  return undefined;
}
const hostAppSchema = z
  .object({
    path: z.string().startsWith("/").max(1024),
    name: z.string().min(1).max(128),
    bundleId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/)
      .optional(),
  })
  .strict();
export type GlideHostApp = z.infer<typeof hostAppSchema>;
const statusSchema = z
  .object({
    accessibility: z.boolean(),
    screenRecording: z.boolean(),
    osMajorVersion: z.number().int().positive().max(1000).optional(),
    responsibleApp: hostAppSchema.nullable().optional(),
    apps: z
      .array(
        z
          .object({
            name: z.string().max(1024),
            bundleId: z.string(),
            path: z.string(),
            pid: z.number().int().positive(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type GlideNativeStatus = z.infer<typeof statusSchema>;
export async function readGlideStatus(helperPath: string): Promise<GlideNativeStatus> {
  try {
    return await readGlideStatusMode(helperPath, ["--status", "--with-host"]);
  } catch {
    // A helper built before host identity rejects the additive flag; its
    // original permission/inventory report remains authoritative.
    return readGlideStatusMode(helperPath, ["--status"]);
  }
}

/** The outermost `.app` bundle containing an executable, or undefined for a
 * bare binary. Used only when the native helper cannot report the TCC
 * responsible process; the owner runtime's own executable is the Electron
 * binary of the desktop bundle that launched it (`ELECTRON_RUN_AS_NODE`). */
export function glideHostAppFromExecutable(executablePath: string): GlideHostApp | undefined {
  if (!executablePath.startsWith("/")) return undefined;
  const components = executablePath.split("/");
  const index = components.findIndex((component) => component.endsWith(".app"));
  if (index <= 0) return undefined;
  const path = components.slice(0, index + 1).join("/");
  const name = components[index]!.slice(0, -".app".length);
  const parsed = hostAppSchema.safeParse({ path, name: name.slice(0, 128) || "Application" });
  return parsed.success ? parsed.data : undefined;
}

function readGlideStatusMode(helperPath: string, args: readonly string[]) {
  return new Promise<GlideNativeStatus>((yes, no) => {
    execFile(
      helperPath,
      [...args],
      {
        timeout: 5000,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
        shell: false,
        env: glideChildEnvironment(process.env),
      },
      (error, stdout) => {
        if (error) {
          no(new Error("Glide permission status is unavailable."));
          return;
        }
        try {
          yes(statusSchema.parse(JSON.parse(stdout)));
        } catch {
          no(new Error("Glide permission status is unavailable."));
        }
      },
    );
  });
}

export async function resolveGlideInstalledApp(helperPath: string, selector: string) {
  return new Promise<z.infer<typeof installedAppSchema>>((yes, no) => {
    // Fixed read-only helper mode and structured argv: resolving an installation
    // neither launches an app nor expands any session's desktop/app grant.
    execFile(
      helperPath,
      ["--resolve-app", selector],
      {
        timeout: 5000,
        maxBuffer: 4096,
        encoding: "utf8",
        shell: false,
        env: glideChildEnvironment(process.env),
      },
      (error, stdout) => {
        if (error) {
          no(
            new Error(
              "Installed application could not be resolved. Use its exact bundle ID or .app path.",
            ),
          );
          return;
        }
        try {
          yes(installedAppSchema.parse(JSON.parse(stdout)));
        } catch {
          no(new Error("Installed application metadata is unavailable."));
        }
      },
    );
  });
}

/** Provider-owner authority. Tokens and session IDs are server minted; model
 * calls never accept a chat ID, app grant, helper path or foreground switch. */
export function makeGlideSessionRuntime(options: {
  helperPath?: string;
  bridgeSource: string;
  mcpPort: number;
  readPolicy(threadId: string): Promise<Policy>;
  initializePolicy?(threadId: string, stopRevision?: string): Promise<void>;
  readStopRevision?(): Promise<string>;
  stopAllPolicies?(): Promise<void>;
  readTitle?(threadId: string): Promise<string>;
  writePolicy(
    threadId: string,
    policy: { enabled: boolean; apps: readonly string[]; desktop?: boolean },
    stopRevision?: string,
  ): Promise<void>;
  trayFactory?: (
    helperPath: string,
    onEvent: (event: GlideTrayEvent) => void,
    onFailure: () => void,
  ) => GlideTrayHost;
  openCafe?: () => Promise<void>;
  applicationName?: string;
  nativeHost?: GlideNativeHost;
  status?: (helperPath: string) => Promise<GlideNativeStatus>;
  /** Fallback host executable; defaults to this process's executable. */
  hostExecutablePath?: string;
  /** Reveals a server-derived bundle path; tests replace the native opener. */
  reveal?: (path: string) => Promise<void>;
  runtimeFactory?: (
    bridge: ReturnType<GlideNativeHost["attach"]>,
    apps: readonly string[],
  ) => Pick<GlideRuntime, "execute" | "reset" | "close">;
}) {
  const host =
    options.nativeHost ??
    new GlideNativeHost(
      (apps, installations) => createGlideNativePeer(options.helperPath!, apps, installations),
      async () => (await (options.status ?? readGlideStatus)(options.helperPath!)).apps,
      (selector) => resolveGlideInstalledApp(options.helperPath!, selector),
    );
  interface Binding {
    id: string;
    tokenDigest: string;
    threadId: string;
    providerInstanceId: string;
    files: SessionMcpFiles;
    active: boolean;
    revoked: boolean;
    paused: boolean;
    revision: number;
    busy: number;
    retiring: boolean;
    provider: string;
    runningTurn?: string;
    disposal?: Promise<void>;
    retirement?: Promise<void>;
    runtime?: Pick<GlideRuntime, "execute" | "reset" | "close">;
    bridge?: ReturnType<GlideNativeHost["attach"]>;
  }
  const bindings = new Map<string, Binding>();
  const current = new Map<string, Binding>();
  const mutating = new Set<string>();
  const publications = new Set<Promise<void>>();
  let metadata: ReturnType<typeof readGlideStatus> | undefined;
  let closed = false;
  let epoch = 0;
  let blocked = false;
  let retirementFailed = false;
  let unconfirmedStop = false;
  let localStopRevision = 0;
  let stopping: Promise<void> | undefined;
  let tray: GlideTrayHost | undefined;
  let trayFailed = false;
  let reveal = 0;
  let cachedStatus: GlideNativeStatus | undefined;
  let navigation: GlideControlResult["navigation"];
  let presentation: { theme?: "dark" | "light"; locale: UiLocale; accent?: string } = {
    locale: "en",
  };
  const activity = new GlideActivity();
  const owners = new Map<string, string>();
  const threadOwners = new Map<string, string>();
  const readStopRevision = () =>
    options.readStopRevision?.() ?? Promise.resolve(String(localStopRevision));
  const forget = (threadId: string) => {
    const owner = threadOwners.get(threadId);
    if (owner) {
      activity.revoke(owner);
      owners.delete(owner);
      threadOwners.delete(threadId);
    }
  };
  const publish = async () => {
    if (!options.helperPath || closed) return;
    if (trayFailed) throw denied();
    tray ??= (options.trayFactory ?? createGlideTrayHost)(
      options.helperPath,
      (event) => {
        if (closed) return;
        if (event.type === "stop-all") {
          void stopAll().catch(() => undefined);
          return;
        }
        if (event.type === "settings") {
          void runtime
            .operation({ kind: "control", input: { action: "open-screen-recording" } })
            .catch(() => undefined);
          return;
        }
        if (event.type === "open-chat") {
          const threadId = owners.get(event.owner);
          if (!threadId) return;
          navigation = {
            id: randomUUID(),
            threadId: threadId as ThreadId,
          };
          const application = glideHostAppFromExecutable(
            options.hostExecutablePath ?? process.execPath,
          );
          void (
            options.openCafe
              ? options.openCafe()
              : application
                ? openCafe(application.path)
                : Promise.resolve()
          ).catch(() => undefined);
        } else if (event.type === "stop-chat") {
          const threadId = owners.get(event.owner);
          if (threadId)
            void runtime
              .operation({ kind: "control", input: { action: "stop", threadId } })
              .catch(() => {
                activity.transition("unavailable");
                void publish().catch(() => undefined);
              });
        }
      },
      () => {
        // Revoke synchronously before any persistence, pipe or process await.
        trayFailed = true;
        void stopAll().catch(() => undefined);
      },
    );
    await tray.publish({
      ...glideTrayPresentation(activity.snapshot(), presentation),
      applicationName: options.applicationName ?? "Cafe Code",
      ...(reveal ? { reveal } : {}),
    });
  };
  const grant = async (threadId: string, binding?: Binding) => {
    const generation = epoch;
    const title = await (options.readTitle?.(threadId) ?? Promise.resolve("Chat"));
    if (
      closed ||
      blocked ||
      stopping !== undefined ||
      retirementFailed ||
      generation !== epoch ||
      (binding && (binding.revoked || current.get(threadId) !== binding))
    )
      throw denied();
    const owner = binding?.id ?? threadOwners.get(threadId) ?? randomUUID();
    if (threadOwners.get(threadId) !== owner) {
      const previous = threadOwners.get(threadId);
      if (previous && activity.activity(previous).state === "stopping") {
        owners.delete(previous);
        threadOwners.delete(threadId);
      } else forget(threadId);
    }
    owners.set(owner, threadId);
    threadOwners.set(threadId, owner);
    activity.grant(owner, title, binding?.provider ?? "Cafe Code");
    activity.running(owner, binding?.runningTurn !== undefined);
    await publish();
  };
  const publishTurn = async (binding: Binding) => {
    const policy = await options.readPolicy(binding.threadId);
    if (
      !closed &&
      !blocked &&
      !binding.revoked &&
      current.get(binding.threadId) === binding &&
      policy.enabled &&
      policy.fullAccess
    )
      await grant(binding.threadId, binding);
    else if (!closed) await publish();
  };
  const stopAll = (): Promise<void> => {
    if (stopping) return stopping;
    epoch++;
    blocked = true;
    unconfirmedStop = true;
    activity.transition("stopping");
    const owned = [...bindings.values()];
    for (const binding of owned) {
      binding.paused = true;
      binding.revision++;
    }
    // Status publication cannot hold the cancellation/control lane hostage.
    void publish().catch(() => undefined);
    stopping = (async () => {
      const results = await Promise.allSettled([
        options.stopAllPolicies?.() ??
          Promise.resolve().then(() => {
            localStopRevision++;
          }),
        ...owned.map(discardKernel),
      ]);
      if (retirementFailed || results.some((result) => result.status === "rejected")) {
        activity.transition("unavailable");
        void publish().catch(() => undefined);
        throw denied();
      }
      owners.clear();
      threadOwners.clear();
      unconfirmedStop = false;
      activity.transition(trayFailed ? "unavailable" : "stopped");
      if (!trayFailed) await publish();
    })().finally(() => {
      stopping = undefined;
    });
    return stopping;
  };
  const hostApp = (status: GlideNativeStatus) =>
    status.responsibleApp ??
    glideHostAppFromExecutable(options.hostExecutablePath ?? process.execPath);
  const cancel = async (binding: Binding) => {
    binding.revision++;
    await binding.runtime?.reset();
  };
  const discardKernel = (binding: Binding): Promise<void> => {
    const kernel = binding.runtime,
      bridge = binding.bridge;
    if (!kernel && !bridge) return binding.retirement ?? Promise.resolve();
    delete binding.runtime;
    delete binding.bridge;
    binding.retiring = true;
    binding.retirement = (async () => {
      const results = await Promise.allSettled([
        binding.retirement,
        kernel?.close(),
        bridge?.close(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        retirementFailed = true;
        blocked = true;
        epoch++;
        throw denied();
      }
    })().finally(() => {
      binding.retiring = false;
    });
    void binding.retirement.catch(() => undefined);
    return binding.retirement;
  };
  const requireBinding = async (token: string, enabled: boolean) => {
    const binding = bindings.get(digest(tokenSchema.parse(token)));
    if (
      closed ||
      blocked ||
      stopping !== undefined ||
      !binding?.active ||
      binding.revoked ||
      binding.paused ||
      current.get(binding.threadId) !== binding ||
      mutating.has(binding.threadId)
    )
      throw denied();
    const revision = binding.revision;
    const runningTurn = binding.runningTurn;
    const policy = await options.readPolicy(binding.threadId);
    const live = () =>
      !closed &&
      !blocked &&
      stopping === undefined &&
      !binding.revoked &&
      !binding.paused &&
      binding.active &&
      (!enabled || (runningTurn !== undefined && binding.runningTurn === runningTurn)) &&
      current.get(binding.threadId) === binding &&
      binding.revision === revision &&
      !mutating.has(binding.threadId);
    if (
      !live() ||
      !policy.fullAccess ||
      (enabled && (!policy.enabled || (!policy.desktop && !policy.apps.length)))
    )
      throw denied();
    return { binding, policy, live };
  };
  const runtime: GlideSessionBroker & {
    operation(operation: GlideOwnerOperation, signal?: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
  } = {
    async bind(input) {
      if (closed || !options.helperPath) return undefined;
      if (bindings.size + publications.size >= 32) throw denied();
      let complete!: () => void;
      const publication = new Promise<void>((yes) => {
        complete = yes;
      });
      publications.add(publication);
      try {
        const token = randomBytes(32).toString("hex");
        const predecessor = current.get(input.threadId);
        const files = await makeSessionMcpFiles({
          bridgeSource: options.bridgeSource,
          port: options.mcpPort,
          token,
          audience: "cafe-glide",
        });
        if (closed) {
          await files.remove();
          throw denied();
        }
        const binding: Binding = {
          id: randomUUID(),
          tokenDigest: digest(token),
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
          files,
          active: false,
          revoked: false,
          paused: false,
          revision: 0,
          busy: 0,
          retiring: false,
          provider:
            input.provider === "claudeAgent"
              ? "Claude"
              : input.provider === "codex"
                ? "Codex"
                : "Grok",
        };
        bindings.set(binding.tokenDigest, binding);
        return {
          name: "cafe-glide",
          launch: {
            command: process.execPath,
            args: [files.bridgePath, files.connectionPath],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
          activate: async () => {
            if (closed || binding.revoked) throw denied();
            const old = current.get(binding.threadId);
            if (old !== predecessor && !(old === undefined && predecessor?.revoked)) throw denied();
            current.set(binding.threadId, binding);
            if (old && old !== binding) {
              old.revoked = true;
              activity.stop(old.id);
              void publish().catch(() => undefined);
              await cancel(old);
              activity.revoke(old.id);
              owners.delete(old.id);
              if (threadOwners.get(binding.threadId) === old.id)
                threadOwners.delete(binding.threadId);
            }
            if (closed || binding.revoked || current.get(binding.threadId) !== binding)
              throw denied();
            binding.active = true;
            const policy = await options.readPolicy(binding.threadId);
            if (policy.enabled && policy.fullAccess && !blocked)
              await grant(binding.threadId, binding);
            else await publish();
          },
          cancel: async () => {
            binding.paused = true;
            const turn = binding.runningTurn;
            await cancel(binding);
            if (binding.paused && binding.runningTurn === turn) {
              delete binding.runningTurn;
              activity.running(binding.id, false);
            }
            await publish();
          },
          resume: () => {
            if (!binding.revoked) binding.paused = false;
          },
          observeTurn: (event) => {
            if (
              closed ||
              binding.revoked ||
              !binding.active ||
              current.get(binding.threadId) !== binding ||
              event.threadId !== binding.threadId
            )
              return;
            if (event.type === "turn.started" && event.turnId !== undefined) {
              if (binding.runningTurn !== event.turnId) binding.revision++;
              binding.runningTurn = event.turnId;
              activity.running(binding.id, true);
              void publishTurn(binding).catch(() => undefined);
            } else if (
              event.type === "session.exited" ||
              ((event.type === "turn.completed" || event.type === "turn.aborted") &&
                event.turnId !== undefined &&
                event.turnId === binding.runningTurn)
            ) {
              binding.revision++;
              delete binding.runningTurn;
              if (binding.busy) activity.stop(binding.id);
              else activity.running(binding.id, false);
              void publish().catch(() => undefined);
            }
          },
          dispose: () => {
            if (binding.disposal) return binding.disposal;
            binding.revoked = true;
            binding.active = false;
            binding.revision++;
            if (current.get(binding.threadId) === binding) current.delete(binding.threadId);
            if (threadOwners.get(binding.threadId) === binding.id) {
              activity.stop(binding.id);
              void publish().catch(() => undefined);
            }
            binding.disposal = (async () => {
              const results = await Promise.allSettled([discardKernel(binding), files.remove()]);
              if (results.some((result) => result.status === "rejected")) throw denied();
              activity.revoke(binding.id);
              owners.delete(binding.id);
              if (threadOwners.get(binding.threadId) === binding.id)
                threadOwners.delete(binding.threadId);
              bindings.delete(binding.tokenDigest);
              await publish();
            })();
            return binding.disposal;
          },
        };
      } finally {
        publications.delete(publication);
        complete();
      }
    },
    async operation(raw, signal) {
      const operation = glideOwnerOperationSchema.parse(raw);
      if (closed) throw denied();
      if (operation.kind === "initialize-thread") {
        if (
          !options.helperPath ||
          !options.initializePolicy ||
          stopping ||
          retirementFailed ||
          unconfirmedStop
        )
          throw denied();
        const revision = await readStopRevision();
        const generation = epoch;
        if ((operation.stopRevision ?? "0") !== revision) throw denied();
        await options.initializePolicy(operation.threadId, revision);
        const policy = await options.readPolicy(operation.threadId);
        if (!policy.enabled || !policy.fullAccess) throw denied();
        if (generation !== epoch || stopping) throw denied();
        if (trayFailed) {
          await tray?.close();
          tray = undefined;
          trayFailed = false;
        }
        if (generation !== epoch || stopping || retirementFailed) throw denied();
        blocked = false;
        await grant(operation.threadId, current.get(operation.threadId));
        return null;
      }
      if (operation.kind === "retire-thread") {
        const owner = threadOwners.get(operation.threadId);
        if (owner) activity.stop(owner);
        void publish().catch(() => undefined);
        const owned = [...bindings.values()].filter(
          (binding) => binding.threadId === operation.threadId,
        );
        for (const binding of owned) {
          binding.paused = true;
          binding.revision++;
        }
        await Promise.all(owned.map(cancel));
        if (owner) {
          activity.revoke(owner);
          owners.delete(owner);
        }
        if (threadOwners.get(operation.threadId) === owner) threadOwners.delete(operation.threadId);
        await publish();
        return null;
      }
      if (operation.kind === "control") {
        const input = operation.input;
        const threadId = "threadId" in input ? input.threadId : undefined;
        if (input.action === "stop-all") await stopAll();
        if (input.action === "presentation") {
          presentation = {
            theme: input.theme,
            locale: input.locale,
            ...(input.accent ? { accent: input.accent } : {}),
          };
          if (!trayFailed) await publish();
        }
        if (input.action === "ack-navigation" && navigation?.id === input.id)
          navigation = undefined;
        if (
          threadId !== undefined &&
          mutating.has(threadId) &&
          input.action !== "activity" &&
          input.action !== "status"
        )
          throw new GlideError({ message: "A Glide permission change is already in progress." });
        if (
          input.action === "configure" ||
          input.action === "set-enabled" ||
          input.action === "stop"
        ) {
          mutating.add(input.threadId);
          const generation = epoch;
          try {
            // Mark every generation before the first awaited cleanup/write.
            const owned = [...bindings.values()].filter((item) => item.threadId === input.threadId);
            for (const binding of owned) {
              binding.revision++;
              if (input.action === "stop") binding.paused = true;
            }
            if (input.action === "stop") {
              const owner = threadOwners.get(input.threadId);
              if (owner) activity.stop(owner);
              void publish().catch(() => undefined);
            }
            const stopRevision = await readStopRevision();
            await Promise.all(owned.map(cancel));
            if (input.action === "stop") {
              await options.writePolicy(input.threadId, {
                enabled: false,
                apps: [],
                desktop: false,
              });
              forget(input.threadId);
              await publish();
            }
            if (input.action === "configure" || input.action === "set-enabled") {
              if (stopping || retirementFailed || generation !== epoch) throw denied();
              // A failed durable global stop may leave other saved grants on.
              // One chat's enable cannot release that fence: Stop all must
              // first commit and join successfully, even after storage recovers.
              if (input.enabled && unconfirmedStop) throw denied();
              await Promise.all(owned.map(discardKernel));
              const policy = await options.readPolicy(input.threadId);
              if (
                input.enabled &&
                (!policy.fullAccess ||
                  !options.helperPath ||
                  (input.action === "configure" && !input.apps.length))
              )
                throw denied();
              if (input.action === "set-enabled" && input.enabled) {
                const permissions = await (options.status ?? readGlideStatus)(options.helperPath!);
                if (!permissions.accessibility || !permissions.screenRecording) throw denied();
              }
              if (generation !== epoch || stopping) throw denied();
              await options.writePolicy(
                input.threadId,
                {
                  enabled: input.enabled,
                  apps: input.action === "configure" ? [...new Set(input.apps)] : [],
                  desktop: input.action === "set-enabled" && input.enabled,
                },
                stopRevision,
              );
              if (generation !== epoch || stopping) throw denied();
              if (input.enabled) {
                if (trayFailed) {
                  await tray?.close();
                  tray = undefined;
                  trayFailed = false;
                }
                if (generation !== epoch || stopping || retirementFailed) throw denied();
                blocked = false;
                for (const binding of owned) binding.paused = false;
                reveal++;
                await grant(input.threadId, current.get(input.threadId));
              } else {
                forget(input.threadId);
                await publish();
              }
            }
          } finally {
            mutating.delete(input.threadId);
          }
        }
        const policy =
          threadId !== undefined
            ? await options.readPolicy(threadId)
            : { enabled: false, apps: [], fullAccess: false };
        if (input.action === "open-accessibility" || input.action === "open-screen-recording") {
          if (!options.helperPath || process.platform !== "darwin") throw denied();
          const pane =
            input.action === "open-accessibility"
              ? "Privacy_Accessibility"
              : "Privacy_ScreenCapture";
          await new Promise<void>((yes, no) =>
            execFile(
              "/usr/bin/open",
              [`x-apple.systempreferences:com.apple.preference.security?${pane}`],
              { timeout: 5000, maxBuffer: 4096, shell: false },
              (error) => (error ? no(denied()) : yes()),
            ),
          );
        }
        const binding = threadId !== undefined ? current.get(threadId) : undefined;
        if (input.action === "reveal-host-app") {
          // Fresh native evidence, never a client-supplied path or the shared
          // status cache, chooses what Finder reveals on this host.
          if (!options.helperPath || (!options.reveal && process.platform !== "darwin"))
            throw denied();
          const fresh = await (options.status ?? readGlideStatus)(options.helperPath);
          const application = hostApp(fresh);
          if (!application) throw denied();
          await (options.reveal ?? revealInFinder)(application.path);
        }
        if (
          options.helperPath &&
          input.action !== "activity" &&
          input.action !== "presentation" &&
          !metadata
        ) {
          const reading = (options.status ?? readGlideStatus)(options.helperPath);
          metadata = reading;
          void reading
            .finally(() => {
              if (metadata === reading) metadata = undefined;
            })
            .catch(() => undefined);
        }
        const status =
          input.action === "activity" ? cachedStatus : await metadata?.catch(() => undefined);
        if (status) cachedStatus = status;
        if (input.action === "status" && !trayFailed) await publish();
        const application = status ? hostApp(status) : undefined;
        return {
          ...(application ? { hostApp: application } : {}),
          ...(status?.osMajorVersion !== undefined
            ? { osMajorVersion: status.osMajorVersion }
            : {}),
          available: !!options.helperPath,
          connected: !!binding?.active && !binding.revoked,
          enabled: policy.enabled,
          fullAccess: policy.fullAccess,
          busy: !!binding?.busy,
          paused: binding?.paused ?? false,
          accessibility: status?.accessibility ?? false,
          screenRecording: status?.screenRecording ?? false,
          apps: [...policy.apps],
          runningApps: (status?.apps ?? []).map((app) => ({
            name: app.name,
            bundleId: app.bundleId,
          })),
          message: !options.helperPath
            ? "Glide requires the macOS desktop helper."
            : !policy.fullAccess
              ? "Select Full access to use Glide."
              : !binding?.active
                ? "Glide connects when this chat next starts a provider session."
                : "Background desktop control",
          stopRevision: await readStopRevision(),
          ...(threadId ? { activity: activity.activity(threadOwners.get(threadId) ?? "") } : {}),
          ...(navigation ? { navigation } : {}),
        } satisfies GlideControlResult;
      }
      if (operation.kind === "catalog") {
        const candidate = bindings.get(digest(operation.token));
        if (!candidate || candidate.revoked) throw denied();
        return { connected: true };
      }
      const { binding, policy, live } = await requireBinding(
        operation.token,
        operation.kind === "execute",
      );
      if (operation.kind === "reset") {
        await cancel(binding);
        return {
          content: [
            { type: "text", text: "Glide kernel reset. Earlier application edits remain." },
          ],
        } satisfies CellResult;
      }
      if (!binding.runtime) {
        // Four bounded 256 MiB workers per provider owner. Explicit permission
        // changes/disposal free a slot; never silently evict another chat's state.
        if ([...bindings.values()].filter((item) => item.runtime || item.retiring).length >= 4)
          throw new GlideError({
            message:
              "Four Glide kernels are already open. Disable Glide in another chat to free one.",
          });
        binding.bridge = host.attach(
          binding.id,
          async () => {
            const authorized = await requireBinding(operation.token, true);
            return {
              apps: authorized.policy.apps,
              desktop: authorized.policy.desktop === true,
              current: authorized.live,
            };
          },
          async (event) => {
            if (event.phase !== "end") await requireBinding(operation.token, true);
            if (event.phase === "start" && threadOwners.get(binding.threadId) !== binding.id)
              await grant(binding.threadId, binding);
            activity.event(binding.id, event);
            if (!closed) await publish();
          },
        );
        binding.runtime =
          options.runtimeFactory?.(binding.bridge, policy.apps) ??
          new GlideRuntime({
            helperPath: options.helperPath!,
            allowedApps: policy.apps,
            nativeBridge: binding.bridge,
          });
      }
      if (!live() || signal?.aborted) throw denied();
      binding.busy++;
      try {
        try {
          return await binding.runtime.execute(operation.input, signal);
        } catch (error) {
          // Keep bounded owned receipts inside the authenticated result body so
          // daemon/supervisor JSON transports do not erase them as opaque errors.
          if (error instanceof GlideExecutionError) return glideExecutionFailure(error);
          throw error;
        }
      } finally {
        binding.busy--;
        if (!binding.busy && binding.runningTurn === undefined) {
          activity.running(binding.id, false);
          if (!closed) void publish().catch(() => undefined);
        }
      }
    },
    async close() {
      closed = true;
      const pending = await Promise.allSettled([stopping, ...publications]);
      for (const binding of bindings.values()) {
        binding.revoked = true;
        binding.revision++;
      }
      const results = await Promise.allSettled(
        [...bindings.values()].map(async (binding) => {
          const closed = await Promise.allSettled([discardKernel(binding), binding.files.remove()]);
          if (closed.some((result) => result.status === "rejected")) throw denied();
        }),
      );
      const nativeClosures = await Promise.allSettled([host.close(), tray?.close()]);
      bindings.clear();
      current.clear();
      if (
        [...pending, ...results, ...nativeClosures].some((result) => result.status === "rejected")
      )
        throw denied();
    },
  };
  return runtime;
}

function openCafe(path: string) {
  return new Promise<void>((yes, no) =>
    execFile(
      "/usr/bin/open",
      ["-a", path],
      { timeout: 5000, maxBuffer: 4096, shell: false },
      (error) => (error ? no(denied()) : yes()),
    ),
  );
}

function revealInFinder(path: string) {
  return new Promise<void>((yes, no) =>
    execFile(
      "/usr/bin/open",
      ["-R", path],
      { timeout: 5000, maxBuffer: 4096, shell: false },
      (error) => (error ? no(denied()) : yes()),
    ),
  );
}

async function remoteOperation(
  endpoint: NonNullable<import("../config.ts").ServerConfigShape["providerDaemon"]>,
  operation: GlideOwnerOperation,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await requestProviderDaemonJson(endpoint, GLIDE_OWNER_PATH, {
    method: "POST",
    body: JSON.stringify(operation),
    timeoutMs: operation.kind === "execute" ? 65_000 : 10_000,
    maxResponseBytes: GLIDE_FRAME_BYTES,
    ...(signal ? { signal } : {}),
  });
  if (response.statusCode !== 200) throw denied();
  return JSON.parse(response.body);
}
export const makeGlideService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const endpoint = config.providerDaemon ?? config.providerSupervisor;
  return (operation: GlideOwnerOperation, signal?: AbortSignal) =>
    endpoint
      ? remoteOperation(endpoint, operation, signal)
      : dispatchGlideOwnerOperation(operation, signal);
});
export const GlideSessionRuntimeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.providerDaemon) return;
    if (config.providerSupervisor) {
      const forward = (operation: GlideOwnerOperation, signal?: AbortSignal) =>
        remoteOperation(config.providerSupervisor!, operation, signal);
      ownerOperation = forward;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (ownerOperation === forward) ownerOperation = undefined;
        }),
      );
      return;
    }
    const policy = yield* makeGlidePolicyStore;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const helperPath = yield* Effect.promise(resolveGlideHelper);
    const runtime = makeGlideSessionRuntime({
      ...(helperPath ? { helperPath } : {}),
      mcpPort: config.cafeMcpPort ?? config.port,
      bridgeSource: fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../dist/glide-mcp-bridge.mjs"
            : "./glide-mcp-bridge.mjs",
          import.meta.url,
        ),
      ),
      readPolicy: (threadId) => run(policy.read(threadId)),
      initializePolicy: (threadId, revision) => run(policy.initialize(threadId, revision)),
      writePolicy: (threadId, next, revision) => run(policy.write(threadId, next, revision)),
      readStopRevision: () => run(policy.revision),
      stopAllPolicies: () => run(policy.stopAll()),
      readTitle: (threadId) => run(policy.title(threadId)),
      applicationName: config.dataProfile === "debug" ? "Cafe Code (Debug)" : "Cafe Code",
    });
    const uninstall = installGlideSessionRuntime(runtime);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        uninstall();
        yield* Effect.promise(runtime.close).pipe(
          Effect.catchCause(() => Effect.logWarning("Glide cleanup remains incomplete.")),
        );
      }),
    );
  }),
);
