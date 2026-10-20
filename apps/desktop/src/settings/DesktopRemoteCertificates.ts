import { uiText } from "@cafecode/shared/i18n";
import type { RemoteCertificatePreparation } from "@cafecode/contracts";
import type * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
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

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-remote-certificates");
// The existing on-disk wire shape remains unchanged; encoding is typed before
// the exclusive temporary write and never introduces certificate payload data.
const encodePinsDocument = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      records: Schema.Array(
        Schema.Struct({ origin: Schema.String, fingerprint256: Schema.String }),
      ),
    }),
  ),
);

export const layer = Layer.effect(
  DesktopRemoteCertificates,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const app = yield* ElectronApp.ElectronApp;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mutex = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
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
        if (!acceptsPinnedRemoteCertificate(pins, url, error, certificate.data)) {
          // The source launcher quiets Chromium's destination-free -202 line.
          // Keep actual rejections visible without copying URLs, query tokens,
          // certificate contents or arbitrary received errors into diagnostics.
          const reason =
            error === "net::ERR_CERT_AUTHORITY_INVALID"
              ? "unapproved-authority"
              : error === "net::ERR_CERT_DATE_INVALID"
                ? "invalid-dates"
                : error === "net::ERR_CERT_COMMON_NAME_INVALID"
                  ? "address-mismatch"
                  : "certificate-error";
          void runPromise(logWarning("TLS certificate rejected", { reason })).catch(() => {});
          return;
        }
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
          yield* encodePinsDocument({
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
              title: uiText("Trust remote Cafe Code server"),
              message: previousPin
                ? uiText("This server’s certificate has changed.")
                : uiText("This server uses a self-signed HTTPS certificate."),
              detail: uiText(
                "{origin}\n\nApprove only if this is your server. Compare this SHA-256 fingerprint with the certificate on the server:\n\n{fingerprint}\n\nValid until {validUntil}. Approval is saved only in Cafe Code for this address, port, and certificate. No sign-in credential has been sent.",
                {
                  origin,
                  fingerprint: certificate.fingerprint256,
                  validUntil: certificate.validToDate.toISOString(),
                },
              ),
              buttons: [uiText("Cancel"), uiText("Trust server")],
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
