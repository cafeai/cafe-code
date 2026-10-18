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
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGlidePolicyStore } from "./policyStore.ts";
import { ServerConfig } from "../config.ts";
import { makeSessionMcpFiles, type SessionMcpFiles } from "../mcp/sessionFiles.ts";
import { createGlideNativePeer, GlideNativeHost } from "./nativeHost.ts";
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
  z.object({ kind: z.literal("initialize-thread"), threadId: z.string().min(1).max(200) }).strict(),
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
            action: z.enum(["status", "open-accessibility", "open-screen-recording"]),
            threadId: z.string().min(1).max(200).optional(),
          })
          .strict(),
        z.object({ action: z.literal("stop"), threadId: z.string().min(1).max(200) }).strict(),
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
const statusSchema = z
  .object({
    accessibility: z.boolean(),
    screenRecording: z.boolean(),
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
export async function readGlideStatus(helperPath: string) {
  return new Promise<z.infer<typeof statusSchema>>((yes, no) => {
    execFile(
      helperPath,
      ["--status"],
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
  initializePolicy?(threadId: string): Promise<void>;
  writePolicy(
    threadId: string,
    policy: { enabled: boolean; apps: readonly string[]; desktop?: boolean },
  ): Promise<void>;
  nativeHost?: GlideNativeHost;
  status?: typeof readGlideStatus;
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
    disposal?: Promise<void>;
    runtime?: Pick<GlideRuntime, "execute" | "reset" | "close">;
    bridge?: ReturnType<GlideNativeHost["attach"]>;
  }
  const bindings = new Map<string, Binding>();
  const current = new Map<string, Binding>();
  const mutating = new Set<string>();
  const publications = new Set<Promise<void>>();
  let metadata: ReturnType<typeof readGlideStatus> | undefined;
  let closed = false;
  const cancel = async (binding: Binding) => {
    binding.revision++;
    await binding.runtime?.reset();
  };
  const discardKernel = async (binding: Binding) => {
    const kernel = binding.runtime,
      bridge = binding.bridge;
    delete binding.runtime;
    delete binding.bridge;
    const results = await Promise.allSettled([kernel?.close(), bridge?.close()]);
    if (results.some((result) => result.status === "rejected")) throw denied();
  };
  const requireBinding = async (token: string, enabled: boolean) => {
    const binding = bindings.get(digest(tokenSchema.parse(token)));
    if (
      closed ||
      !binding?.active ||
      binding.revoked ||
      binding.paused ||
      current.get(binding.threadId) !== binding ||
      mutating.has(binding.threadId)
    )
      throw denied();
    const revision = binding.revision;
    const policy = await options.readPolicy(binding.threadId);
    const live = () =>
      !closed &&
      !binding.revoked &&
      !binding.paused &&
      binding.active &&
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
              await cancel(old);
            }
            if (closed || binding.revoked || current.get(binding.threadId) !== binding)
              throw denied();
            binding.active = true;
          },
          cancel: () => {
            binding.paused = true;
            return cancel(binding);
          },
          resume: () => {
            if (!binding.revoked) binding.paused = false;
          },
          dispose: () => {
            if (binding.disposal) return binding.disposal;
            binding.revoked = true;
            binding.active = false;
            binding.revision++;
            if (current.get(binding.threadId) === binding) current.delete(binding.threadId);
            binding.disposal = (async () => {
              const results = await Promise.allSettled([discardKernel(binding), files.remove()]);
              if (results.some((result) => result.status === "rejected")) throw denied();
              bindings.delete(binding.tokenDigest);
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
        if (!options.helperPath || !options.initializePolicy) throw denied();
        await options.initializePolicy(operation.threadId);
        return null;
      }
      if (operation.kind === "retire-thread") {
        const owned = [...bindings.values()].filter(
          (binding) => binding.threadId === operation.threadId,
        );
        for (const binding of owned) {
          binding.paused = true;
          binding.revision++;
        }
        await Promise.all(owned.map(cancel));
        return null;
      }
      if (operation.kind === "control") {
        const input = operation.input;
        if (input.threadId !== undefined && mutating.has(input.threadId))
          throw new GlideError({ message: "A Glide permission change is already in progress." });
        if (
          input.action === "configure" ||
          input.action === "set-enabled" ||
          input.action === "stop"
        ) {
          mutating.add(input.threadId);
          try {
            // Mark every generation before the first awaited cleanup/write.
            const owned = [...bindings.values()].filter((item) => item.threadId === input.threadId);
            for (const binding of owned) {
              binding.revision++;
              if (input.action === "stop") binding.paused = true;
            }
            await Promise.all(owned.map(cancel));
            if (input.action === "configure" || input.action === "set-enabled") {
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
              await options.writePolicy(input.threadId, {
                enabled: input.enabled,
                apps: input.action === "configure" ? [...new Set(input.apps)] : [],
                desktop: input.action === "set-enabled" && input.enabled,
              });
            }
          } finally {
            mutating.delete(input.threadId);
          }
        }
        const policy =
          input.threadId !== undefined
            ? await options.readPolicy(input.threadId)
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
        const binding = input.threadId !== undefined ? current.get(input.threadId) : undefined;
        if (options.helperPath && !metadata) {
          const reading = (options.status ?? readGlideStatus)(options.helperPath);
          metadata = reading;
          void reading
            .finally(() => {
              if (metadata === reading) metadata = undefined;
            })
            .catch(() => undefined);
        }
        const status = await metadata?.catch(() => undefined);
        return {
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
        if ([...bindings.values()].filter((item) => item.runtime).length >= 4)
          throw new GlideError({
            message:
              "Four Glide kernels are already open. Disable Glide in another chat to free one.",
          });
        binding.bridge = host.attach(binding.id, async () => {
          const authorized = await requireBinding(operation.token, true);
          return {
            apps: authorized.policy.apps,
            desktop: authorized.policy.desktop === true,
            current: authorized.live,
          };
        });
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
      }
    },
    async close() {
      closed = true;
      await Promise.all(publications);
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
      await host.close();
      bindings.clear();
      current.clear();
      if (results.some((result) => result.status === "rejected")) throw denied();
    },
  };
  return runtime;
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
      initializePolicy: (threadId) => run(policy.initialize(threadId)),
      writePolicy: (threadId, next) => run(policy.write(threadId, next)),
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
