import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { BrandingImageStore, BrandingImageStoreLive } from "./BrandingImageStore.ts";

const tinyPngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

const makeLayer = () =>
  BrandingImageStoreLive.pipe(
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-branding-image-store-" })),
    ),
  );

it.layer(NodeServices.layer)("branding image store", (it) => {
  it.effect("stores valid sidebar images by content hash and deduplicates repeats", () =>
    Effect.gen(function* () {
      const store = yield* BrandingImageStore;
      const first = yield* store.storeUploadedImage({
        bytes: tinyPngBytes,
        declaredMimeType: "image/png",
      });
      const second = yield* store.storeUploadedImage({
        bytes: tinyPngBytes,
        declaredMimeType: "image/png",
      });
      const stored = yield* store.resolveStoredImage(first.id);
      const fs = yield* FileSystem.FileSystem;

      assert.equal(first.id, second.id);
      assert.equal(first.url, `/api/branding/sidebar-image/${first.id}`);
      assert.equal(first.mimeType, "image/png");
      assert.equal(first.width, 1);
      assert.equal(first.height, 1);
      assert.equal(first.sizeBytes, tinyPngBytes.byteLength);
      assert.equal(stored.mimeType, "image/png");
      assert.isTrue(yield* fs.exists(stored.filePath));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects unsupported, mismatched, and invalid sidebar image data", () =>
    Effect.gen(function* () {
      const store = yield* BrandingImageStore;
      const unsupported = yield* Effect.exit(
        store.storeUploadedImage({
          bytes: tinyPngBytes,
          declaredMimeType: "image/svg+xml",
        }),
      );
      const mismatched = yield* Effect.exit(
        store.storeUploadedImage({
          bytes: tinyPngBytes,
          declaredMimeType: "image/jpeg",
        }),
      );
      const invalid = yield* Effect.exit(
        store.storeUploadedImage({
          bytes: new Uint8Array([1, 2, 3, 4]),
          declaredMimeType: "image/png",
        }),
      );

      assert.equal(unsupported._tag, "Failure");
      assert.equal(mismatched._tag, "Failure");
      assert.equal(invalid._tag, "Failure");
      assert.isFalse(String(unsupported).includes("data:image"));
      assert.isFalse(String(mismatched).includes("data:image"));
      assert.isFalse(String(invalid).includes("data:image"));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("stores valid legacy data URLs without preserving data URL bytes", () =>
    Effect.gen(function* () {
      const store = yield* BrandingImageStore;
      const stored = yield* store.storeLegacyDataUrl(
        `data:image/png;base64,${Buffer.from(tinyPngBytes).toString("base64")}`,
      );

      assert.match(stored.id, /^sha256-[a-f0-9]{64}\.png$/);
      assert.isFalse(Object.values(stored).some((value) => String(value).includes("data:image")));
    }).pipe(Effect.provide(makeLayer())),
  );
});
