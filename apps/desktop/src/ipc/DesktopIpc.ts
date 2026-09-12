import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export interface DesktopIpcWebContents {
  readonly id?: number;
  isDestroyed?: () => boolean;
  once?: (event: "destroyed", listener: () => void) => unknown;
}

export interface DesktopIpcWebFrame {
  readonly url: string;
  readonly top?: DesktopIpcWebFrame | null;
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
    rendererUrl: string,
  ) => Effect.Effect<void>;
  readonly handle: <E, R>(
    input: DesktopIpcMethod<E, R>,
  ) => Effect.Effect<void, never, R | Scope.Scope>;
  readonly handleFromSender: <E, R>(
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

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") return true;
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
}

function trustedDesktopIpcFrameScope(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      url.search = "";
      url.hash = "";
      return url.href;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return isLoopbackHostname(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function isTrustedDesktopIpcFrameUrl(rawUrl: string): boolean {
  return trustedDesktopIpcFrameScope(rawUrl) !== null;
}

export function isTrustedDesktopIpcNavigation(rawUrl: string, rendererUrl: string): boolean {
  const trustedScope = trustedDesktopIpcFrameScope(rendererUrl);
  return trustedScope !== null && trustedDesktopIpcFrameScope(rawUrl) === trustedScope;
}

function isTopLevelFrame(frame: DesktopIpcWebFrame): boolean {
  return frame.top === undefined || frame.top === null || frame.top === frame;
}

function validateDesktopIpcSender(
  event: DesktopIpcInvokeEvent | DesktopIpcSyncEvent,
  trustedWebContents: WeakMap<object, string>,
): void {
  const sender = event.sender;
  const trustedScope =
    typeof sender === "object" && sender !== null ? trustedWebContents.get(sender) : undefined;
  if (!sender || trustedScope === undefined) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from an untrusted webContents.");
  }

  if (sender.isDestroyed?.() === true) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from a destroyed webContents.");
  }

  const frame = event.senderFrame;
  if (!frame || !isTopLevelFrame(frame)) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from an untrusted frame.");
  }

  if (trustedDesktopIpcFrameScope(frame.url) !== trustedScope) {
    throw new DesktopIpcSenderValidationError("Rejected IPC call from an untrusted frame URL.");
  }
}

export const make = (ipcMain: DesktopIpcMain): DesktopIpcShape => {
  const trustedWebContents = new WeakMap<object, string>();

  const handle = Effect.fn("desktop.ipc.registerInvoke")(function* <E, R>({
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
            validateDesktopIpcSender(event, trustedWebContents);
          } catch (error) {
            return Promise.reject(error);
          }

          return runPromise(
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({ channel });
              return yield* handler(raw, event);
            }).pipe(Effect.annotateLogs({ channel }), Effect.withSpan("desktop.ipc.invoke")),
          );
        });
      }),
      () => Effect.sync(() => ipcMain.removeHandler(channel)),
    );
  });

  return DesktopIpc.of({
    trustWebContents: (webContents, rendererUrl) =>
      Effect.sync(() => {
        const trustedScope = trustedDesktopIpcFrameScope(rendererUrl);
        if (trustedScope === null) {
          throw new DesktopIpcSenderValidationError(
            "Cannot trust a webContents for an invalid renderer URL.",
          );
        }
        trustedWebContents.set(webContents, trustedScope);
      }),

    handle,
    handleFromSender: handle,

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
              validateDesktopIpcSender(event, trustedWebContents);
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
  readonly strict?: true;
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
      decode(raw, method.strict ? { onExcessProperty: "error" } : undefined).pipe(
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
