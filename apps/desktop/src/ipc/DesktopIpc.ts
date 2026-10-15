import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export interface DesktopIpcWebContents {
  readonly id?: number;
  readonly mainFrame?: DesktopIpcWebFrame;
  isDestroyed?: () => boolean;
  on?: {
    (
      event: "did-start-navigation",
      listener: (details: {
        readonly isMainFrame: boolean;
        readonly isSameDocument: boolean;
      }) => void,
    ): unknown;
    (event: "render-process-gone", listener: () => void): unknown;
    (event: "destroyed", listener: () => void): unknown;
  };
}

export interface DesktopIpcWebFrame {
  readonly url: string;
  readonly top?: DesktopIpcWebFrame | null;
  /** Native document identity is required by delayed image-save publication. */
  readonly detached?: boolean;
  readonly frameToken?: string;
  readonly processId?: number;
  readonly routingId?: number;
}

export interface DesktopIpcInvokeEvent {
  readonly sender?: DesktopIpcWebContents;
  readonly senderFrame?: DesktopIpcWebFrame | null;
}

export interface DesktopIpcSyncEvent {
  returnValue: unknown;
  readonly sender?: DesktopIpcWebContents;
  readonly senderFrame?: DesktopIpcWebFrame | null;
}

export type DesktopIpcHandleListener = (
  event: DesktopIpcInvokeEvent,
  raw: unknown,
) => unknown | Promise<unknown>;

export type DesktopIpcSyncListener = (event: DesktopIpcSyncEvent) => void;

export interface DesktopIpcMain {
  removeHandler(channel: string): void;
  handle(channel: string, listener: DesktopIpcHandleListener): void;
  removeAllListeners(channel: string): void;
  on(channel: string, listener: DesktopIpcSyncListener): void;
}

export interface DesktopIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: (raw: unknown, event: DesktopIpcInvokeEvent) => Effect.Effect<unknown, E, R>;
}

export interface DesktopSyncIpcMethod<E, R> {
  readonly channel: string;
  readonly handler: () => Effect.Effect<unknown, E, R>;
}

export interface DesktopIpcShape {
  readonly trustWebContents: (
    webContents: DesktopIpcWebContents,
    policy: { readonly url: URL; readonly role: "main" | "dictation" },
  ) => Effect.Effect<void>;
  readonly handle: <E, R>(
    input: DesktopIpcMethod<E, R>,
  ) => Effect.Effect<void, never, R | Scope.Scope>;
  readonly handleSync: <E, R>(
    input: DesktopSyncIpcMethod<E, R>,
  ) => Effect.Effect<void, never, R | Scope.Scope>;
}

export class DesktopIpc extends Context.Service<DesktopIpc, DesktopIpcShape>()(
  "cafecode/desktop/Ipc",
) {}

export class DesktopIpcSenderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopIpcSenderValidationError";
  }
}

export function isTrustedDesktopIpcFrameUrl(rawUrl: string, expectedUrl: URL): boolean {
  try {
    const url = new URL(rawUrl);
    // The application origin also serves received attachments and API data.
    // Those response documents must never inherit the application's bridge.
    const firstSegment = decodeURIComponent(url.pathname)
      .replaceAll("\\", "/")
      .split("/")
      .find((segment) => segment.length > 0)
      ?.toLowerCase();
    if (
      firstSegment?.includes("%") ||
      ["api", "mcp", "attachments", "assets", ".well-known"].includes(firstSegment ?? "")
    )
      return false;
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.origin === expectedUrl.origin
    );
  } catch {
    return false;
  }
}

type TrustPolicy = { readonly url: URL; readonly role: "main" | "dictation"; revision: number };

function isTopLevelFrame(frame: DesktopIpcWebFrame): boolean {
  return frame.top === undefined || frame.top === null || frame.top === frame;
}

function validateDesktopIpcSender(
  event: DesktopIpcInvokeEvent | DesktopIpcSyncEvent,
  trustedWebContents: WeakMap<object, TrustPolicy>,
  channel: string,
): void {
  const sender = event.sender;
  if (typeof sender !== "object" || sender === null || !trustedWebContents.has(sender)) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from an untrusted webContents.");
  }

  if (sender.isDestroyed?.() === true) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from a destroyed webContents.");
  }

  const frame = event.senderFrame;
  if (!frame || !isTopLevelFrame(frame) || frame !== sender.mainFrame || frame.detached === true) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from an untrusted frame.");
  }

  const policy = trustedWebContents.get(sender)!;
  if (
    !isTrustedDesktopIpcFrameUrl(frame.url, policy.url) ||
    (policy.role === "dictation" &&
      (channel !== "desktop:get-local-environment-bootstrap" || frame.url !== policy.url.href))
  ) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from an untrusted frame URL.");
  }
}

export const make = (ipcMain: DesktopIpcMain): DesktopIpcShape => {
  const trustedWebContents = new WeakMap<object, TrustPolicy>();

  return DesktopIpc.of({
    trustWebContents: (webContents, policy) =>
      Effect.sync(() => {
        const record: TrustPolicy = { ...policy, url: new URL(policy.url.href), revision: 0 };
        trustedWebContents.set(webContents, record);
        webContents.on?.("did-start-navigation", (details) => {
          if (details?.isMainFrame && details.isSameDocument !== true) record.revision++;
        });
        webContents.on?.("render-process-gone", () => {
          record.revision++;
        });
        webContents.on?.("destroyed", () => {
          record.revision++;
          trustedWebContents.delete(webContents);
        });
      }),

    handle: Effect.fn("desktop.ipc.registerInvoke")(function* <E, R>({
      channel,
      handler,
    }: DesktopIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runPromise = Effect.runPromiseWith(context);

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, (event, raw) => {
            try {
              validateDesktopIpcSender(event, trustedWebContents, channel);
            } catch (error) {
              return Promise.reject(error);
            }

            const policy = trustedWebContents.get(event.sender!)!;
            const revision = policy.revision;
            const frame = event.senderFrame!;
            const identity = [frame.url, frame.frameToken, frame.processId, frame.routingId];
            return runPromise(
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({ channel });
                const result = yield* handler(raw, event);
                yield* Effect.sync(() => {
                  validateDesktopIpcSender(event, trustedWebContents, channel);
                  if (
                    trustedWebContents.get(event.sender!) !== policy ||
                    policy.revision !== revision ||
                    [frame.url, frame.frameToken, frame.processId, frame.routingId].some(
                      (value, index) => value !== identity[index],
                    )
                  ) {
                    throw new DesktopIpcSenderValidationError(
                      "Rejected IPC result for a replaced document.",
                    );
                  }
                });
                return result;
              }).pipe(Effect.annotateLogs({ channel }), Effect.withSpan("desktop.ipc.invoke")),
            );
          });
        }),
        () => Effect.sync(() => ipcMain.removeHandler(channel)),
      );
    }),

    handleSync: Effect.fn("desktop.ipc.registerSync")(function* <E, R>({
      channel,
      handler,
    }: DesktopSyncIpcMethod<E, R>) {
      yield* Effect.annotateCurrentSpan({ channel });
      const context = yield* Effect.context<R>();
      const runSync = Effect.runSyncWith(context);

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          ipcMain.removeAllListeners(channel);
          ipcMain.on(channel, (event) => {
            try {
              validateDesktopIpcSender(event, trustedWebContents, channel);
            } catch (error) {
              if (error instanceof DesktopIpcSenderValidationError) {
                event.returnValue = null;
                return;
              }
              throw error;
            }

            event.returnValue = runSync(
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({ channel });
                return yield* handler();
              }).pipe(Effect.annotateLogs({ channel }), Effect.withSpan("desktop.ipc.invokeSync")),
            );
          });
        }),
        () => Effect.sync(() => ipcMain.removeAllListeners(channel)),
      );
    }),
  });
};

/**
 * Convenience helpers for creating IPC methods
 */

export interface DesktopIpcMethodRegistration<
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly payload: Schema.Codec<
    Payload,
    EncodedPayload,
    PayloadDecodingServices,
    PayloadEncodingServices
  >;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  /** Passed only after top-level sender validation; native pickers bind to this sender. */
  readonly handler: (input: Payload, event: DesktopIpcInvokeEvent) => Effect.Effect<Result, E, R>;
}

export const makeIpcMethod = <
  Payload,
  EncodedPayload,
  Result,
  EncodedResult,
  E,
  R,
  PayloadDecodingServices = never,
  PayloadEncodingServices = never,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopIpcMethodRegistration<
    Payload,
    EncodedPayload,
    Result,
    EncodedResult,
    E,
    R,
    PayloadDecodingServices,
    PayloadEncodingServices,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopIpcMethod<
  E | Schema.SchemaError,
  R | PayloadDecodingServices | ResultEncodingServices
> => {
  const decode = Schema.decodeUnknownEffect(method.payload);
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: (raw, event) =>
      decode(raw).pipe(
        Effect.flatMap((input) => method.handler(input, event)),
        Effect.flatMap(encode),
        Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
      ),
  };
};

export interface DesktopSyncIpcMethodRegistration<
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
> {
  readonly channel: string;
  readonly result: Schema.Codec<
    Result,
    EncodedResult,
    ResultDecodingServices,
    ResultEncodingServices
  >;
  readonly handler: () => Effect.Effect<Result, E, R>;
}

export const makeSyncIpcMethod = <
  Result,
  EncodedResult,
  E,
  R,
  ResultDecodingServices = never,
  ResultEncodingServices = never,
>(
  method: DesktopSyncIpcMethodRegistration<
    Result,
    EncodedResult,
    E,
    R,
    ResultDecodingServices,
    ResultEncodingServices
  >,
): DesktopSyncIpcMethod<E | Schema.SchemaError, R | ResultEncodingServices> => {
  const encode = Schema.encodeUnknownEffect(method.result);

  return {
    channel: method.channel,
    handler: () =>
      method
        .handler()
        .pipe(
          Effect.flatMap(encode),
          Effect.withSpan("desktop.ipc.method", { attributes: { channel: method.channel } }),
        ),
  };
};
