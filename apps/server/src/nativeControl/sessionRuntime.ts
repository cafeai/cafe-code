// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  NATIVE_CONTROL_AUDIENCE,
  NATIVE_CONTROL_HOST_FILE,
  readNativeControlHost,
  requestNativeControlHost,
} from "@cafecode/shared/nativeControl";
import type { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { ServerConfig } from "../config.ts";
import { makeSchedulingSessionFiles } from "../scheduledFollowups/sessionFiles.ts";

export interface NativeControlSessionBinding {
  readonly name: string;
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  readonly activate: () => Promise<void>;
  readonly beginTurn: () => Promise<void>;
  readonly endTurn: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}
export interface NativeControlSessionBroker {
  readonly bind: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: "codex" | "claudeAgent";
  }) => Promise<NativeControlSessionBinding | undefined>;
}
let broker: NativeControlSessionBroker | undefined;
export const readNativeControlSessionBroker = () => broker;
export function installNativeControlSessionBroker(value: NativeControlSessionBroker) {
  broker = value;
  return () => {
    if (broker === value) broker = undefined;
  };
}

export function makeNativeControlSessionBroker(options: {
  readonly stateDirectory: string;
  readonly bridgeSource: string;
  readonly executable?: string;
  readonly platform?: NodeJS.Platform;
}): NativeControlSessionBroker & { readonly close: () => Promise<void> } {
  const bindings = new Set<NativeControlSessionBinding>();
  let closed = false;
  return {
    async bind(input) {
      if (closed || (options.platform ?? process.platform) !== "darwin") return undefined;
      const host = await readNativeControlHost(
        join(options.stateDirectory, NATIVE_CONTROL_HOST_FILE),
      ).catch(() => undefined);
      // Ordinary headless/remote backends have no Electron-owned host. They
      // continue normal provider startup without native desktop tools.
      if (!host) return undefined;
      const minted = await requestNativeControlHost(host, "bind", input).catch(() => undefined);
      if (
        !minted ||
        typeof minted.token !== "string" ||
        !/^[a-f0-9]{64}$/u.test(minted.token) ||
        typeof minted.url !== "string"
      )
        return undefined;
      const target = new URL(minted.url);
      if (target.origin !== new URL(host.url).origin || target.pathname !== "/mcp/native-control")
        throw new Error("Invalid native desktop session transport.");
      const token = minted.token;
      const files = await makeSchedulingSessionFiles({
        bridgeSource: options.bridgeSource,
        port: Number(target.port),
        token,
        audience: NATIVE_CONTROL_AUDIENCE,
      }).catch(async () => {
        await requestNativeControlHost(host, "dispose", { token }).catch(() => undefined);
        throw new Error("Could not prepare the private native desktop bridge.");
      });
      let disposed = false;
      let retirement: Promise<void> | undefined;
      const update = async (operation: string) => {
        if (!disposed) await requestNativeControlHost(host, operation, { token });
      };
      const binding: NativeControlSessionBinding = {
        name: `cafe-native-${Buffer.from(token.slice(0, 32), "hex").toString("base64url")}`,
        launch: {
          command: options.executable ?? process.execPath,
          args: [files.bridgePath, files.connectionPath],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
        activate: () => update("activate"),
        // Host restarts or revocation must not block unrelated provider work.
        // A dead capability cannot invoke desktop tools; the provider can
        // continue normally and reconnect through normal session restart.
        beginTurn: () => update("begin-turn").catch(() => undefined),
        endTurn: () => update("end-turn").catch(() => undefined),
        dispose: async () => {
          if (retirement) return retirement;
          disposed = true;
          retirement = (async () => {
            await requestNativeControlHost(host, "dispose", { token }).catch(() => undefined);
            await files.remove();
            bindings.delete(binding);
          })();
          await retirement;
        },
      };
      if (closed) {
        await binding.dispose();
        return undefined;
      }
      bindings.add(binding);
      return binding;
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled([...bindings].map((binding) => binding.dispose()));
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Native session file cleanup is incomplete.");
    },
  };
}

export const NativeControlSessionRuntimeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.providerDaemon || config.providerSupervisor) return;
    const runtime = makeNativeControlSessionBroker({
      stateDirectory: config.stateDir,
      bridgeSource: fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../dist/native-desktop-mcp-bridge.mjs"
            : "./native-desktop-mcp-bridge.mjs",
          import.meta.url,
        ),
      ),
    });
    const uninstall = installNativeControlSessionBroker(runtime);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        uninstall();
        await runtime.close();
      }).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Native desktop session cleanup remains incomplete."),
        ),
      ),
    );
  }),
);
