import { z } from "zod";

// These ceilings apply at both ends of the child-process boundary. Images are
// carried inline, so the framing allowance includes base64's expansion.
export const GLIDE_FRAME_BYTES = 12 * 1024 * 1024;
export const GLIDE_IMAGE_BYTES = 8 * 1024 * 1024;
export const GLIDE_OUTPUT_BYTES = 10 * 1024 * 1024;
export const GLIDE_CODE_BYTES = 128 * 1024;
export const GLIDE_TIMEOUT_MS = 30_000;
export const GLIDE_MAX_TIMEOUT_MS = 60_000;
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
  | { type: "image"; mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string };
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
              mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
              data: z.string().max(GLIDE_FRAME_BYTES),
            })
            .strict(),
        ]),
      )
      .max(129),
    isError: z.boolean().optional(),
  })
  .strict();

export function glideInstructions(): string {
  return `Run JavaScript in OpenAI's installed persistent computer-use runtime. The native OpenAI kernel supplies global cua and dynamic import("@oai/sky"). Use cua.listApps() or var app = await cua.getApp("application") and read the emitted native documentation before acting. App handles expose getAXState(), getScreenshot(), getAXStateAndScreenshot(), click(), drag(), scroll(), setValue(), selectText(), typeText(), pressKey(), paste() and performSecondaryAction(). Use dynamic imports; static imports are not supported. nodeRepl.write(value) emits text and await nodeRepl.emitImage(image) emits an image. Variables persist until reset or session retirement. Use fresh observations and verify the application result after actions. Prefer paste() for accented text and emoji: direct typing dropped those characters in the qualified native fixture. Cafe authorizes each individual native app request against this exact chat's current grant and Full access; native policy and macOS permissions still apply. Computer use Off and Stop retire this chat's owned runtime. Earlier actions remain and cancellation does not prove already-dispatched input was undone. Never replay uncertain input automatically. Browser and audio services are not enabled. This runs local code. Cafe adds no OS sandbox; OpenAI owns its runtime isolation.`;
}
