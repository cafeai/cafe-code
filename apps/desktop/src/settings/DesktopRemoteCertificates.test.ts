import * as NodeServices from "@effect/platform-node/NodeServices";
import { X509Certificate } from "node:crypto";
// Native fixture boundary: exercise actual filesystem and host-path identity semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopRemoteCertificates from "./DesktopRemoteCertificates.ts";

const probe = vi.hoisted(() => vi.fn());
vi.mock("./remoteCertificatePolicy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remoteCertificatePolicy.ts")>()),
  probeRemoteCertificate: probe,
}));

const cert = readFileSync(
  new URL("./__fixtures__/remote-tls/test-only-cert.pem", import.meta.url),
  "utf8",
);
const certificate = new X509Certificate(cert);
const origin = "https://127.0.0.1:3775";
type CertificateListener = (
  event: Electron.Event,
  contents: Electron.WebContents,
  url: string,
  error: string,
  certificate: Electron.Certificate,
  callback: (trusted: boolean) => void,
) => void;

beforeEach(() => {
  probe.mockReset();
  probe.mockResolvedValue({ status: "self-signed", certificate });
});

const pinsDocument = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    records: Schema.Array(Schema.Struct({ origin: Schema.String, fingerprint256: Schema.String })),
  }),
);
const encodePinsDocument = Schema.encodeEffect(pinsDocument);
const decodePinsDocument = Schema.decodeEffect(pinsDocument);
const encodeDiagnosticJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture<E>(
  options: {
    response: number;
    corrupt?: boolean;
    failWrite?: boolean;
    previousFingerprint?: string;
  },
  test: (input: {
    service: DesktopRemoteCertificates.DesktopRemoteCertificatesShape;
    check: (url?: string, error?: string) => boolean;
    warnings: Array<{ message: string; annotations: Readonly<Record<string, unknown>> }>;
    fileSystem: FileSystem.FileSystem;
    registryPath: string;
    showMessageBox: ReturnType<typeof vi.fn>;
    reload: <A>(
      effect: Effect.Effect<A, never, DesktopRemoteCertificates.DesktopRemoteCertificates>,
    ) => Effect.Effect<A>;
  }) => Effect.Effect<void, E>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafe-certificate-test-",
        });
        const registryPath = path.join(directory, "remote-certificates.json");
        if (options.corrupt) yield* fileSystem.writeFileString(registryPath, "corrupt");
        if (options.previousFingerprint)
          yield* fileSystem.writeFileString(
            registryPath,
            yield* encodePinsDocument({
              version: 1,
              records: [{ origin, fingerprint256: options.previousFingerprint }],
            }),
          );
        if (options.failWrite) yield* fileSystem.makeDirectory(registryPath);
        let listener: CertificateListener | undefined;
        const warnings: Array<{ message: string; annotations: Readonly<Record<string, unknown>> }> =
          [];
        const logger = Logger.make(({ message, fiber }) => {
          warnings.push({
            message: String(message),
            annotations: fiber.getRef(References.CurrentLogAnnotations),
          });
        });
        const showMessageBox = vi
          .fn()
          .mockReturnValue(Effect.succeed({ response: options.response, checkboxChecked: false }));
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            dataProfile: "production",
            configuredBaseDir: directory,
            savedEnvironmentRegistryPath: path.join(directory, "saved-environments.json"),
          } as DesktopEnvironment.DesktopEnvironmentShape),
          Layer.succeed(ElectronDialog.ElectronDialog, {
            showMessageBox,
          } as unknown as ElectronDialog.ElectronDialogShape),
          Layer.succeed(ElectronApp.ElectronApp, {
            on: (_event: string, callback: CertificateListener) =>
              Effect.sync(() => {
                listener = callback;
              }),
          } as unknown as ElectronApp.ElectronAppShape),
        );
        const layer = DesktopRemoteCertificates.layer.pipe(Layer.provide(dependencies));
        const reload = <A>(
          effect: Effect.Effect<A, never, DesktopRemoteCertificates.DesktopRemoteCertificates>,
        ): Effect.Effect<A> => effect.pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const service = yield* DesktopRemoteCertificates.DesktopRemoteCertificates;
          yield* test({
            service,
            registryPath,
            fileSystem,
            showMessageBox,
            warnings,
            reload,
            check: (url = origin, error = "net::ERR_CERT_AUTHORITY_INVALID") => {
              const preventDefault = vi.fn();
              const callback = vi.fn();
              listener?.(
                { preventDefault } as unknown as Electron.Event,
                {} as Electron.WebContents,
                url,
                error,
                { data: cert } as Electron.Certificate,
                callback,
              );
              return preventDefault.mock.calls.length === 1 && callback.mock.calls[0]?.[0] === true;
            },
          });
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("desktop remote certificate approval", () => {
  it("keeps approved peers quiet and reports rejection without copying URL credentials or received errors", () =>
    fixture({ response: 1 }, ({ service, check, warnings }) =>
      Effect.gen(function* () {
        expect(yield* service.prepare(origin)).toBe("approved");
        expect(check(`${origin}/?wsToken=private-fixture-token`)).toBe(true);
        yield* Effect.yieldNow;
        expect(warnings).toEqual([]);
        expect(check("https://127.0.0.1:3776/private/path?wsToken=private-fixture-token")).toBe(
          false,
        );
        expect(check(origin, "net::ERR_CERT_DATE_INVALID")).toBe(false);
        expect(check(origin, "net::ERR_CERT_COMMON_NAME_INVALID")).toBe(false);
        expect(check(origin, "private arbitrary received diagnostic")).toBe(false);
        yield* Effect.yieldNow;
        expect(warnings.map((entry) => entry.message)).toEqual(
          Array(4).fill("TLS certificate rejected"),
        );
        expect(warnings.map((entry) => entry.annotations.reason)).toEqual([
          "unapproved-authority",
          "invalid-dates",
          "address-mismatch",
          "certificate-error",
        ]);
        expect(encodeDiagnosticJson(warnings.map((entry) => entry.annotations))).not.toMatch(
          /private|wsToken|3776/,
        );
      }),
    ));
  it.each([0, 1])(
    "requires a new decision after a certificate changes (response %s)",
    (response) => {
      const previousFingerprint = Array(32).fill("AA").join(":");
      return fixture(
        { response, previousFingerprint },
        ({ service, check, fileSystem, registryPath, showMessageBox }) =>
          Effect.gen(function* () {
            expect(check()).toBe(false);
            expect(yield* service.prepare(origin)).toBe(response === 1 ? "approved" : "declined");
            expect(check()).toBe(response === 1);
            expect(showMessageBox.mock.calls[0]?.[0].message).toBe(
              "This server’s certificate has changed.",
            );
            const document = yield* decodePinsDocument(
              yield* fileSystem.readFileString(registryPath),
            );
            expect(document.records).toEqual([
              {
                origin,
                fingerprint256: response === 1 ? certificate.fingerprint256 : previousFingerprint,
              },
            ]);
          }),
      );
    },
  );
  it("cancel never grants or persists trust, even with corrupt prior storage", () =>
    fixture(
      { response: 0, corrupt: true },
      ({ service, check, registryPath, fileSystem, showMessageBox }) =>
        Effect.gen(function* () {
          expect(check()).toBe(false);
          expect(yield* service.prepare(`${origin}/`)).toBe("declined");
          expect(check()).toBe(false);
          expect(yield* fileSystem.readFileString(registryPath)).toBe("corrupt");
          expect(showMessageBox.mock.calls[0]?.[0]).toMatchObject({
            defaultId: 0,
            cancelId: 0,
            buttons: ["Cancel", "Trust server"],
          });
          expect(showMessageBox.mock.calls[0]?.[0].detail).toContain(certificate.fingerprint256);
        }),
    ));

  it("persists explicit approval, scopes it to one origin, and restores it without another prompt", () =>
    fixture(
      { response: 1 },
      ({ service, check, registryPath, fileSystem, showMessageBox, reload }) =>
        Effect.gen(function* () {
          expect(check()).toBe(false);
          expect(yield* service.prepare(origin)).toBe("approved");
          expect(check()).toBe(true);
          expect(check("https://127.0.0.1:3776/")).toBe(false);
          const document = yield* decodePinsDocument(
            yield* fileSystem.readFileString(registryPath),
          );
          expect(document).toEqual({
            version: 1,
            records: [{ origin, fingerprint256: certificate.fingerprint256 }],
          });
          if (process.platform !== "win32")
            expect((yield* fileSystem.stat(registryPath)).mode & 0o777).toBe(0o600);
          yield* reload(
            Effect.gen(function* () {
              const reloaded = yield* DesktopRemoteCertificates.DesktopRemoteCertificates;
              expect(check()).toBe(true);
              expect(yield* reloaded.prepare(origin)).toBe("approved");
            }),
          );
          expect(showMessageBox).toHaveBeenCalledOnce();
        }),
    ));

  it("fails closed when approval cannot be saved", () =>
    fixture({ response: 1, failWrite: true }, ({ service, check }) =>
      Effect.gen(function* () {
        expect(yield* service.prepare(origin)).toBe("storage-error");
        expect(check()).toBe(false);
      }),
    ));

  it.each(["invalid-certificate", "unreachable", "unchanged"])(
    "does not offer an override for %s",
    (status) => {
      probe.mockResolvedValue({ status });
      return fixture({ response: 1 }, ({ service, check, showMessageBox }) =>
        Effect.gen(function* () {
          expect(yield* service.prepare(origin)).toBe(status);
          expect(check()).toBe(false);
          expect(showMessageBox).not.toHaveBeenCalled();
        }),
      );
    },
  );
});
