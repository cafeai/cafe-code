// Exact inherited pipe ownership, native backpressure and close are not path IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createWriteStream, fstatSync } from "node:fs";
import { DESKTOP_POWER_STATE_FD, type DesktopPowerState } from "@cafecode/shared/desktopPowerState";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { ServerConfig } from "./config.ts";
import { ServerClientSettingsService } from "./serverClientSettings.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

class DesktopPowerPipeUnavailable extends Data.TaggedError("DesktopPowerPipeUnavailable")<{}> {}

/** The capability comes only from an exact desktop child's private bootstrap.
 * No ambient fd, public HTTP descriptor, selected remote, or provider daemon
 * can opt into this machine-level action. A failed optional publisher closes
 * its own pipe and expires power intent without failing ordinary chat startup. */
export const startDesktopPowerState = Effect.gen(function* () {
  const config = yield* ServerConfig;
  if (
    process.platform !== "darwin" ||
    config.mode !== "desktop" ||
    config.desktopPowerStateFd !== DESKTOP_POWER_STATE_FD
  )
    return;
  const settings = yield* ServerClientSettingsService;
  const query = yield* ProjectionSnapshotQuery;
  yield* Effect.gen(function* () {
    const writer = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const descriptor = fstatSync(DESKTOP_POWER_STATE_FD);
          if (!descriptor.isFIFO() && !descriptor.isSocket()) throw new Error("Not a private pipe");
          const stream = createWriteStream("", {
            fd: DESKTOP_POWER_STATE_FD,
            autoClose: true,
            highWaterMark: 256,
          });
          // Install completion before the first native write or possible error.
          const closed = new Promise<void>((resolve) => stream.once("close", resolve));
          stream.on("error", () => {});
          return { stream, closed };
        },
        catch: () => new DesktopPowerPipeUnavailable(),
      }),
      ({ stream, closed }) =>
        Effect.promise(async () => {
          stream.destroy();
          await closed;
        }),
    );
    yield* settings.ready;
    let sequence = 0;
    while (Number.isSafeInteger(sequence)) {
      const current = yield* settings.getSettings;
      // Disabled preferences never query work, and this query reads only
      // current lightweight ownership. It never probes/open providers.
      const workActive = current.keepAwakeWithLidClosed
        ? yield* query.hasActiveDesktopWork()
        : false;
      const state: DesktopPowerState = {
        version: 1,
        sequence: sequence++,
        enabled: current.keepAwakeWithLidClosed,
        workActive,
      };
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            if (writer.stream.destroyed || writer.stream.writableLength > 256) {
              reject(new Error("Power pipe unavailable"));
              return;
            }
            writer.stream.write(`${JSON.stringify(state)}\n`, (error) =>
              error ? reject(new Error("Power pipe write failed")) : resolve(),
            );
          }),
        catch: () => new DesktopPowerPipeUnavailable(),
      }).pipe(Effect.timeout("1 second"));
      yield* Effect.sleep("1 second");
    }
  }).pipe(
    Effect.scoped,
    // Never render/log native errors, preference values, paths or frames.
    Effect.catchCause(() => Effect.logWarning("Desktop power-state publisher retired")),
    Effect.forkScoped,
  );
});
