import { z } from "zod";
import { desktopError } from "./nativeClient.ts";

const coordinate = z.number().int().min(0).max(2047);
const point = { x: coordinate, y: coordinate };
const button = z.number().int().min(272).max(279).optional();
const text = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const desktopAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), ...point }).strict(),
  z.object({ kind: z.literal("click"), ...point, button }).strict(),
  z.object({ kind: z.literal("drag"), ...point, toX: coordinate, toY: coordinate }).strict(),
  z
    .object({
      kind: z.literal("scroll"),
      amount: z.number().int().min(-100).max(100),
      horizontal: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("text"), text }).strict(),
  z
    .object({
      kind: z.literal("key"),
      keys: z
        .array(
          z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9_]+$/),
        )
        .min(1)
        .max(8),
    })
    .strict(),
]);
export type DesktopAction = z.infer<typeof desktopAction>;
export const desktopRegion = z
  .object({
    ...point,
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
  })
  .strict();
export type DesktopRegion = z.infer<typeof desktopRegion>;
export const observeInput = {
  since: z.string().uuid().optional(),
  force: z.boolean().optional(),
  region: desktopRegion.optional(),
  windowId: z.number().int().positive().optional(),
};
export const observeSchema = z
  .object(observeInput)
  .strict()
  .refine((value) => !(value.region && value.windowId));
export type ObserveInput = z.infer<typeof observeSchema>;
export const waitFor = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("screen_change"), timeoutMs: z.number().int().min(100).max(5000) })
    .strict(),
  z
    .object({
      type: z.literal("window"),
      timeoutMs: z.number().int().min(100).max(5000),
      windowId: z.number().int().positive().optional(),
      appId: z.string().min(1).max(160).optional(),
    })
    .strict()
    .refine((value) => value.windowId !== undefined || value.appId !== undefined),
]);
// Keep the legacy single-action fields in discovery. Decode the complete union
// below at the runtime boundary as daemon callers do not pass through MCP Zod.
export const actInput = {
  kind: z.enum(["move", "click", "drag", "scroll", "text", "key"]).optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  toX: coordinate.optional(),
  toY: coordinate.optional(),
  button,
  amount: z.number().int().min(-100).max(100).optional(),
  horizontal: z.boolean().optional(),
  text: text.optional(),
  keys: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
  actions: z.array(desktopAction).min(1).max(24).optional(),
  observationId: z.string().uuid().optional(),
  waitFor: waitFor.optional(),
  observeAfter: z.enum(["none", "if_changed", "always"]).optional(),
};
export function decodeDesktopInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw desktopError(
      "invalid_request",
      "Invalid desktop input. Check the tool's fields and bounds.",
    );
  return result.data;
}
export function decodeAct(value: unknown) {
  const decoded = decodeDesktopInput(z.object(actInput).strict(), value);
  const { actions, observationId, waitFor, observeAfter, ...single } = decoded;
  if (actions && Object.keys(single).length)
    throw desktopError("invalid_request", "Choose a single action or actions, not both.");
  const steps = actions ?? [decodeDesktopInput(desktopAction, single)];
  if (
    steps.reduce(
      (bytes, step) => bytes + (step.kind === "text" ? Buffer.byteLength(step.text) : 0),
      0,
    ) > 4096
  )
    throw desktopError(
      "invalid_request",
      "An action sequence accepts at most 4096 UTF-8 text bytes.",
    );
  return { actions: steps, observationId, waitFor, observeAfter: observeAfter ?? "none" };
}
