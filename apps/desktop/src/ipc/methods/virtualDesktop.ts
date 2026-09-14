import { VirtualDesktopConnect } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const openVirtualDesktop = makeIpcMethod({
  channel: IpcChannels.OPEN_VIRTUAL_DESKTOP_CHANNEL,
  payload: VirtualDesktopConnect,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.openVirtualDesktop")(function* (input) {
    const manager = yield* DesktopBackendManager.DesktopBackendManager;
    const config = Option.getOrNull(yield* manager.currentConfig);
    return yield* Effect.tryPromise({
      try: () => connectLocalVirtualDesktop(input, config),
      catch: () => new Error("Could not connect to this virtual desktop from the local client."),
    });
  }),
});

export async function connectLocalVirtualDesktop(
  input: VirtualDesktopConnect,
  config: Pick<DesktopBackendManager.DesktopBackendStartConfig, "bootstrap" | "httpBaseUrl"> | null,
  platform: NodeJS.Platform = process.platform,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
) {
  if (
    platform !== "linux" ||
    !config?.bootstrap.desktopBootstrapToken ||
    new URL(input.environmentUrl).origin !== config.httpBaseUrl.origin
  )
    throw new Error();
  const environment: Record<string, string> = {};
  for (const name of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    if (hostEnvironment[name]) environment[name] = hostEnvironment[name];
  const response = await fetch(new URL("/api/virtual-desktops/connect", config.httpBaseUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.bootstrap.desktopBootstrapToken}`,
    },
    body: JSON.stringify({
      id: input.id,
      environment,
      ...(input.appearance ? { appearance: input.appearance } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error();
}
