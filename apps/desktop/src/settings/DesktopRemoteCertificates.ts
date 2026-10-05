import type { RemoteCertificatePreparation } from "@cafecode/contracts";
import type * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import {
  acceptsPinnedRemoteCertificate,
  decodeRemoteCertificatePins,
  probeRemoteCertificate,
  remoteCertificateOrigin,
} from "./remoteCertificatePolicy.ts";

export interface DesktopRemoteCertificatesShape {
  readonly prepare: (httpBaseUrl: string) => Effect.Effect<RemoteCertificatePreparation>;
}

export class DesktopRemoteCertificates extends Context.Service<
  DesktopRemoteCertificates,
  DesktopRemoteCertificatesShape
>()("cafecode/desktop/RemoteCertificates") {}

export const layer = Layer.effect(
  DesktopRemoteCertificates,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const app = yield* ElectronApp.ElectronApp;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mutex = yield* Semaphore.make(1);
    const registryPath = path.join(
      path.dirname(environment.savedEnvironmentRegistryPath),
      "remote-certificates.json",
    );
    let pins = yield* fileSystem.stat(registryPath).pipe(
      Effect.flatMap((stat) =>
        stat.type === "File" && stat.size <= 65_536n
          ? fileSystem.readFileString(registryPath).pipe(Effect.map(decodeRemoteCertificatePins))
          : Effect.succeed(new Map<string, string>()),
      ),
      Effect.catch(() => Effect.succeed(new Map<string, string>())),
    );

    yield* app.on(
      "certificate-error",
      (
        event: Electron.Event,
        _webContents: Electron.WebContents,
        url: string,
        error: string,
        certificate: Electron.Certificate,
        callback: (trusted: boolean) => void,
      ) => {
        if (!acceptsPinnedRemoteCertificate(pins, url, error, certificate.data)) return;
        event.preventDefault();
        callback(true);
      },
    );

    const persist = (nextPins: ReadonlyMap<string, string>) =>
      Effect.gen(function* () {
        const suffix = yield* Random.nextUUIDv4;
        const tempPath = `${registryPath}.${suffix}.tmp`;
        yield* fileSystem.makeDirectory(path.dirname(registryPath), { recursive: true });
        yield* fileSystem.writeFileString(
          tempPath,
          JSON.stringify({
            version: 1,
            records: [...nextPins].map(([origin, fingerprint256]) => ({ origin, fingerprint256 })),
          }),
          { mode: 0o600, flag: "wx" },
        );
        yield* fileSystem
          .rename(tempPath, registryPath)
          .pipe(Effect.ensuring(fileSystem.remove(tempPath).pipe(Effect.ignore)));
      });

    return DesktopRemoteCertificates.of({
      prepare: (httpBaseUrl) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            const origin = remoteCertificateOrigin(httpBaseUrl);
            if (!origin || !httpBaseUrl.startsWith("https:")) return "invalid-certificate" as const;
            const probe = yield* Effect.promise(() => probeRemoteCertificate(origin));
            if (probe.status !== "self-signed") return probe.status;
            const certificate = probe.certificate;
            if (pins.get(origin) === certificate.fingerprint256) return "approved" as const;
            const previousPin = pins.has(origin);
            const result = yield* dialog.showMessageBox({
              type: "warning",
              title: "Trust remote Cafe Code server",
              message: previousPin
                ? "This server’s certificate has changed."
                : "This server uses a self-signed HTTPS certificate.",
              detail: `${origin}\n\nApprove only if this is your server. Compare this SHA-256 fingerprint with the certificate on the server:\n\n${certificate.fingerprint256}\n\nValid until ${certificate.validToDate.toISOString()}. Approval is saved only in Cafe Code for this address, port, and certificate. No sign-in credential has been sent.`,
              buttons: ["Cancel", "Trust server"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            });
            if (result.response !== 1) return "declined" as const;
            if (pins.size >= 128 && !previousPin) return "storage-error" as const;
            const nextPins = new Map(pins).set(origin, certificate.fingerprint256);
            const saved = yield* persist(nextPins).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (!saved) return "storage-error" as const;
            pins = nextPins;
            return "approved" as const;
          }),
        ),
    });
  }),
);
