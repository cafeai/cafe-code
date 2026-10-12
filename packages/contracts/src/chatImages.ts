import * as Schema from "effect/Schema";

export const CHAT_IMAGES_PATH = "/api/chat-images";
export const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_IMAGE_MAX_PER_MESSAGE = 8;
export const ChatImageMetadata = Schema.Struct({
  source: Schema.String,
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  width: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  height: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: CHAT_IMAGE_MAX_BYTES }),
  ),
});
export type ChatImageMetadata = typeof ChatImageMetadata.Type;
export const ChatImageManifest = Schema.Array(ChatImageMetadata);
