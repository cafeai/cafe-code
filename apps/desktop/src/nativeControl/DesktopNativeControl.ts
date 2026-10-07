import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { join } from "node:path";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { NativeControlHost } from "./NativeControlHost.ts";

export class DesktopNativeControl extends Context.Service<
  DesktopNativeControl,
  NativeControlHost
>()("cafecode/desktop/NativeControl") {}

export const layer = Layer.effect(
  DesktopNativeControl,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const host = new NativeControlHost({
      stateDirectory: environment.stateDir,
      runtimeRoot: environment.isPackaged
        ? join(environment.resourcesPath, "cua-driver")
        : join(
            environment.rootDir,
            "native",
            "cua-driver",
            "runtime",
            `${environment.platform}-${environment.processArch}`,
          ),
      // The source launcher and packaged app both use this actual macOS
      // CFBundleIdentifier; the development AppUserModelID differs.
      hostBundleId: "com.cafeai.cafecode",
    });
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        if (environment.platform === "darwin") {
          await host.listen();
          // The user selected default-on local control. Starting the embedded
          // helper does not grant TCC permissions or authorize an idle chat;
          // the normal native and active-turn gates still apply to every call.
          await host.setEnabled(true);
        }
        return host;
      }),
      (value) =>
        Effect.promise(() => value.close()).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Native desktop controller cleanup remains incomplete."),
          ),
        ),
    );
    return host;
  }),
);
