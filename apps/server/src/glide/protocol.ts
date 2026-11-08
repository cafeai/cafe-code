import { z } from "zod";

// These ceilings apply at both ends of the child-process boundary. Images are
// carried inline, so the framing allowance includes base64's expansion.
export const GLIDE_FRAME_BYTES = 12 * 1024 * 1024;
export const GLIDE_IMAGE_BYTES = 8 * 1024 * 1024;
export const GLIDE_OUTPUT_BYTES = 10 * 1024 * 1024;
export const GLIDE_CODE_BYTES = 128 * 1024;
export const GLIDE_TIMEOUT_MS = 30_000;
export const GLIDE_MAX_TIMEOUT_MS = 60_000;
export const glideInputModeSchema = z.enum(["background", "foreground"]).default("background");
export type GlideInputMode = z.infer<typeof glideInputModeSchema>;

const app = z.string().trim().min(1).max(1024);
const index = z.number().int().positive();
const coordinate = z.number().finite().min(-100_000).max(100_000);
const text = z.string().max(16 * 1024);
const windowId = z.number().int().positive().max(0xffffffff);
const appWindow = { app, windowId: windowId.optional() };
const target = {
  ...appWindow,
  element_index: index.optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
};
const hasOneTarget = (input: {
  element_index?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
}) =>
  input.element_index === undefined
    ? input.x !== undefined && input.y !== undefined
    : input.x === undefined && input.y === undefined;
const value = text;
export const glideRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("list_apps"), input: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("list_windows"), input: z.object({ app }).strict() }).strict(),
  z.object({ method: z.literal("resolve_app"), input: z.object({ app }).strict() }).strict(),
  z.object({ method: z.literal("launch_app"), input: z.object({ app }).strict() }).strict(),
  z.object({ method: z.literal("restore_window"), input: z.object(appWindow).strict() }).strict(),
  z
    .object({
      method: z.literal("focus_element"),
      input: z.object({ ...appWindow, element_index: index }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type_into"),
      input: z
        .object({ ...appWindow, element_index: index, text, replace: z.boolean().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("get_app_state"),
      input: z
        .object({
          ...appWindow,
          disableDiff: z.boolean().optional(),
          includeScreenshot: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("click"),
      input: z
        .object({
          ...target,
          mouse_button: z.enum(["left", "right", "middle"]).optional(),
          click_count: z.number().int().min(1).max(3).optional(),
          key: z.string().max(128).optional(),
          duration: z.number().min(0).max(5).optional(),
        })
        .strict()
        .refine(hasOneTarget, "Choose one element index or one coordinate pair."),
    })
    .strict(),
  z
    .object({
      method: z.literal("drag"),
      input: z
        .object({
          ...appWindow,
          from_x: coordinate,
          from_y: coordinate,
          to_x: coordinate,
          to_y: coordinate,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      input: z
        .object({
          ...target,
          direction: z.enum(["up", "down", "left", "right"]),
          pages: z.number().positive().max(20).optional(),
        })
        .strict()
        .refine(hasOneTarget, "Choose one element index or one coordinate pair."),
    })
    .strict(),
  z
    .object({
      method: z.literal("set_value"),
      input: z.object({ ...appWindow, element_index: index, value }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("select_text"),
      input: z
        .object({
          ...appWindow,
          element_index: index,
          text,
          prefix: text.optional(),
          suffix: text.optional(),
          selection_type: z.enum(["text", "cursor_before", "cursor_after"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ method: z.literal("type_text"), input: z.object({ ...appWindow, text }).strict() })
    .strict(),
  z
    .object({
      method: z.literal("press_key"),
      input: z
        .object({
          ...appWindow,
          key: z.string().min(1).max(128),
          duration: z.number().min(0).max(5).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("paste"),
      input: z.object({ ...appWindow, text, format: z.enum(["text", "md", "html"]) }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("perform_secondary_action"),
      input: z
        .object({ ...appWindow, element_index: index, action: z.string().min(1).max(128) })
        .strict(),
    })
    .strict(),
]);
export type GlideRequest = z.infer<typeof glideRequestSchema>;

export const installedAppSchema = z
  .object({
    name: z.string().min(1).max(1024),
    bundleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/u),
    path: z.string().min(1).max(1024),
  })
  .strict();

const scalar = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);
// Receipts are evidence, never input authority. A posted event has no OS delivery
// acknowledgment; even a matching AX value does not prove an application goal.
export const actionReceiptSchema = z
  .object({
    actionId: z.string().min(1).max(128),
    method: z.string().min(1).max(64),
    status: z.enum(["verified", "unverified", "not-observed", "uncertain", "refused"]),
    dispatch: z.enum(["not-dispatched", "dispatched", "unknown"]),
    osAcceptance: z.enum(["accepted", "rejected", "unacknowledged", "unknown"]),
    osStatus: z.number().int().optional(),
    stage: z.string().min(1).max(128),
    progress: z
      .object({
        axAttempted: z.number().int().nonnegative().nullable(),
        axAccepted: z.number().int().nonnegative().nullable(),
        eventsPosted: z.number().int().nonnegative().nullable(),
        textScalarsPosted: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    verification: z
      .object({
        kind: z.enum(["none", "value", "focus", "text", "selection", "application", "window"]),
        matched: z.boolean().nullable(),
        before: scalar.optional(),
        after: scalar.optional(),
      })
      .strict(),
    message: z.string().max(2048).optional(),
    interruption: z
      .object({
        event: z.enum(["key-down", "button-down", "scroll"]),
        source: z.enum(["external-process", "unattributed"]),
        sourcePid: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    candidates: z
      .array(
        z
          .object({
            index: index,
            role: z.string().max(128),
            bounds: z
              .object({
                x: coordinate,
                y: coordinate,
                width: z.number().finite().nonnegative(),
                height: z.number().finite().nonnegative(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.status === "verified" &&
      (receipt.verification.kind === "none" || receipt.verification.matched !== true)
    )
      context.addIssue({
        code: "custom",
        message: "Verified actions require an observed named postcondition.",
      });
    if (receipt.status === "not-observed" && receipt.verification.matched !== false)
      context.addIssue({
        code: "custom",
        message: "A missing postcondition requires an observed mismatch.",
      });
    const { axAttempted, axAccepted } = receipt.progress;
    if (axAttempted !== null && axAccepted !== null && axAccepted > axAttempted)
      context.addIssue({ code: "custom", message: "Accepted AX calls exceed attempted calls." });
  });
export type GlideActionReceipt = z.infer<typeof actionReceiptSchema>;

export const isGlideAction = (method: string) =>
  !["list_apps", "list_windows", "get_app_state", "resolve_app", "retire_session"].includes(method);

/** A legacy peer or a lost transport cannot mint OS acceptance or verification. */
export function unknownActionReceipt(
  method: string,
  actionId: string,
  message?: string,
): GlideActionReceipt {
  return {
    actionId,
    method,
    status: "uncertain",
    dispatch: "unknown",
    osAcceptance: "unknown",
    stage: "response-unavailable",
    progress: { axAttempted: null, axAccepted: null, eventsPosted: null, textScalarsPosted: null },
    verification: { kind: "none", matched: null },
    ...(message === undefined ? {} : { message: message.slice(0, 2048) }),
  };
}

export const observationSchema = z
  .object({
    app: z.string(),
    text: z.string().max(512 * 1024),
    screenshot: z
      .object({ url: z.string().max(GLIDE_FRAME_BYTES) })
      .strict()
      .nullable(),
    revision: z.number().int().positive(),
    pid: z.number().int().positive(),
    windowId: z.number().int().nonnegative(),
    accessibilityAvailable: z.boolean().optional(),
    bounds: z
      .object({
        x: coordinate,
        y: coordinate,
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
    screenshotWidth: z.number().int().positive(),
    screenshotHeight: z.number().int().positive(),
    capturedAt: z.string(),
    windowTitle: z.string().max(4096).optional(),
    processBirth: z
      .string()
      .regex(/^[0-9]{1,20}:[0-9]{1,20}$/)
      .optional(),
    screenshotPreview: z
      .string()
      .max(96 * 1024)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/)
      .optional(),
  })
  .strict();
export type GlideObservation = z.infer<typeof observationSchema>;
export const windowListSchema = z
  .array(
    z
      .object({
        id: windowId,
        title: z.string().max(4096),
        bounds: z
          .object({
            x: coordinate,
            y: coordinate,
            width: z.number().positive(),
            height: z.number().positive(),
          })
          .strict(),
        onScreen: z.boolean(),
      })
      .strict(),
  )
  .max(128);
export const appListSchema = z
  .array(
    z
      .object({
        name: z.string(),
        bundleId: z.string(),
        path: z.string(),
        pid: z.number().int().positive(),
      })
      .strict(),
  )
  .max(256);

export const jsInputSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .refine(
        (code) => Buffer.byteLength(code) <= GLIDE_CODE_BYTES,
        "JavaScript cell is too large.",
      ),
    title: z.string().trim().min(1).max(80).optional(),
    timeout_ms: z.number().int().min(1).max(GLIDE_MAX_TIMEOUT_MS).optional(),
  })
  .strict();

export type GlideOutput =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png"; data: string };
export type CellResult = { content: GlideOutput[]; isError?: boolean | undefined };
export const cellResultSchema = z
  .object({
    content: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string().max(GLIDE_OUTPUT_BYTES) }).strict(),
          z
            .object({
              type: z.literal("image"),
              mimeType: z.literal("image/png"),
              data: z.string().max(GLIDE_FRAME_BYTES),
            })
            .strict(),
        ]),
      )
      .max(129),
    isError: z.boolean().optional(),
  })
  .strict();

export function glideInstructions(
  inputMode: GlideInputMode = "background",
  managed = false,
): string {
  return `Run JavaScript in a persistent Glide kernel. Top-level await, let/const/var, functions and app handles persist between cells. Use glide.listApps() to discover explicitly allowed running macOS applications, then await glide.listWindows("application") and var app = await glide.getApp("application", {windowId: observedWindowId}). Omitting windowId is allowed only when the native window is unambiguous. getApp emits initial accessibility text and performs bounded observation-only rediscovery if startup changes process identity. glide.resolveApp(bundleIdOrAbsoluteAppPath) resolves installed applications, including stopped apps; glide.launchApp(selector) launches that exact installation without activation in background mode. A verified launch establishes only a running process: list windows and obtain a fresh app handle afterward. restoreWindow() explicitly unhides/unminimizes the observed window without raising or activating it, and invalidates old observations. Background launch/restoration requests may be refused or uncertain if the app or OS changes the foreground/Space; never fall back to foreground or replay automatically. Actions marked blockedActions are not currently available; AXRaise requires foreground mode. Use await app.getAXStateAndScreenshot() to see the window. Element indices come only from the most recent observation; coordinates are absolute macOS screen points, with bounds and screenshot dimensions returned alongside observations. Available app methods: restoreWindow(), focus(index), typeInto(index,text,{replace?}?), click(target, options?), drag([x,y],[x,y]), scroll(target,direction,pages?), setValue(index,value), selectText(index,text,{prefix?,suffix?,selectionType?}?), typeText(text), pressKey(key,{durationMs?}?), paste(text,{format?:"text"|"md"|"html"}?), performSecondaryAction(index,action), getAXState({emit?,disableDiffing?}?), getScreenshot({emit?}?), getAXStateAndScreenshot({emit?,disableDiffing?}?). target is an observed index or [x,y]. Import { glide } from "@cafecode/glide" when an explicit import is useful. cua is a compatibility alias for glide, and sky exposes the corresponding legacy snake_case methods with object arguments. getAXState returns text, getScreenshot returns PNG Uint8Array, and getAXStateAndScreenshot returns {state,screenshot?}. Rich HTML paste accepts inert well-formed text tags without resource or style attributes. nodeRepl.write(value) emits text; nodeRepl.emitImage accepts PNG bytes or a PNG data URL. The final expression is not automatically printed. Each action returns and automatically emits a structured receipt: dispatch, osAcceptance, progress, verification, status and optional interruption/candidates. OS acceptance is not UI completion; posted events have no delivery acknowledgment. setValue verifies AX readback; typeInto explicitly verifies focus and readable text, with replace:true selecting and verifying the full range before typing. Prefer typeInto for fields; click/AXPress alone does not establish typing focus. Secure fields do not expose before/after values or allow verified replacement. verified receipts prove only their named postcondition, never the whole application task. not-observed, refused and uncertain receipts throw GlideActionError with .receipt and stop an awaited chain; inspect fresh state before deciding what remains. glide.getActionReceipts({emit?,clear?}) returns the latest 64 receipts, including steps before a failed cell. Progress counts submitted AX calls, events and Unicode scalars, not committed characters. Interruption metadata describes outside event provenance, not proof of physical human input. Coordinate ambiguity lists at most eight candidates; select a fresh exact index rather than guessing. Chain related actions with await, then obtain a fresh observation to verify the result. Earlier effects survive errors and reset. ${inputMode === "background" ? "This connection uses background control: observations do not activate or raise apps; input is addressed to the observed process/window with synthetic focus and no foreground fallback. Background delivery must be verified with a fresh observation. Clipboard paste still shares the system clipboard." : "This connection explicitly uses foreground control: observations and input may activate and raise the target app; pointer input moves the pointer."} ${managed ? "Cafe serializes native operations across chat sessions. The user enables or revokes desktop access using the Computer use switch in the composer. Stop pauses this session until the next admitted provider turn. A helper restart invalidates every old observation; refresh app state before further input." : "The first native observation or input reserves this backend for the connection until js_reset or close; competing connections fail busy."} Cancellation/timeout destroys the current kernel and retires its owned native work; an already-dispatched OS event may still take effect. Do not blindly replay an uncertain action. Browser and audio APIs are not exposed. This is trusted local code execution for explicitly enabled sessions; the JavaScript VM is not an OS sandbox.`;
}
