import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClientSettingsPatch,
  DEFAULT_CLIENT_SETTINGS,
  MAX_SIDEBAR_STAR_SPEED,
} from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "./config.ts";
import { BrandingImageStoreLive } from "./branding/BrandingImageStore.ts";
import { ServerClientSettingsLive, ServerClientSettingsService } from "./serverClientSettings.ts";

const makeServerClientSettingsLayer = () =>
  ServerClientSettingsLive.pipe(
    Layer.provideMerge(BrandingImageStoreLive),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-client-settings-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server client settings", (it) => {
  it.effect("decodes client settings patches with existing field limits", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);

      assert.deepEqual(decodePatch({ sidebarStarSpeed: MAX_SIDEBAR_STAR_SPEED }), {
        sidebarStarSpeed: MAX_SIDEBAR_STAR_SPEED,
      });
      assert.throws(() => decodePatch({ sidebarStarSpeed: MAX_SIDEBAR_STAR_SPEED * 2 }));
    }),
  );

  it.effect("migrates legacy desktop client-settings.json branding images", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const legacyPngDataUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
      yield* fs.writeFileString(
        config.clientSettingsPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          brandWordmarkPrefix: "Acme",
          sidebarBrandImageDataUrl: legacyPngDataUrl,
          chatCopyFormat: "plainText",
        }),
      );

      const service = yield* ServerClientSettingsService;
      const settings = yield* service.getSettings;
      const raw = yield* fs.readFileString(config.clientSettingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw) as typeof settings;

      assert.equal(settings.brandWordmarkPrefix, "Acme");
      assert.equal(settings.sidebarBrandImageDataUrl, "");
      assert.isNotNull(settings.sidebarBrandImage);
      assert.equal(settings.sidebarBrandImage?.mimeType, "image/png");
      assert.equal(settings.sidebarBrandImage?.width, 1);
      assert.equal(settings.sidebarBrandImage?.height, 1);
      assert.equal(persisted.sidebarBrandImageDataUrl, "");
      assert.isFalse(raw.includes("data:image"));
      assert.equal(settings.chatCopyFormat, "plainText");
      assert.equal(settings.showSidebarMascot, DEFAULT_CLIENT_SETTINGS.showSidebarMascot);
    }).pipe(Effect.provide(makeServerClientSettingsLayer())),
  );

  it.effect("clears invalid legacy desktop client-settings.json branding images", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      yield* fs.writeFileString(
        config.clientSettingsPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          sidebarBrandImageDataUrl: "data:image/png;base64,not-image",
        }),
      );

      const service = yield* ServerClientSettingsService;
      const settings = yield* service.getSettings;
      const raw = yield* fs.readFileString(config.clientSettingsPath);

      assert.equal(settings.sidebarBrandImageDataUrl, "");
      assert.isNull(settings.sidebarBrandImage);
      assert.isFalse(raw.includes("data:image"));
    }).pipe(Effect.provide(makeServerClientSettingsLayer())),
  );

  it.effect("patches and persists the full client settings document atomically", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const service = yield* ServerClientSettingsService;

      const next = yield* service.updateSettings({
        brandWordmarkPrefix: "Lab",
        defaultEditor: "cursor",
        powerSaveBlockerMode: "during-chats",
        showSidebarAttribution: false,
      });
      const raw = yield* fs.readFileString(config.clientSettingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw) as typeof next;

      assert.equal(next.brandWordmarkPrefix, "Lab");
      assert.equal(persisted.brandWordmarkPrefix, "Lab");
      assert.equal(persisted.defaultEditor, "cursor");
      assert.equal(persisted.powerSaveBlockerMode, "during-chats");
      assert.equal(persisted.showSidebarMascot, DEFAULT_CLIENT_SETTINGS.showSidebarMascot);
      assert.equal(persisted.chatCopyFormat, DEFAULT_CLIENT_SETTINGS.chatCopyFormat);
    }).pipe(Effect.provide(makeServerClientSettingsLayer())),
  );

  it.effect("emits change events when client settings update", () =>
    Effect.gen(function* () {
      const service = yield* ServerClientSettingsService;
      const takeNext = yield* Stream.runHead(service.streamChanges).pipe(Effect.forkScoped);

      yield* service.updateSettings({ brandWordmarkPrefix: "Streamed" });
      const event = yield* Fiber.join(takeNext);

      assert.isTrue(event._tag === "Some");
      if (event._tag === "Some") {
        assert.equal(event.value.brandWordmarkPrefix, "Streamed");
      }
    }).pipe(Effect.provide(makeServerClientSettingsLayer())),
  );
});
