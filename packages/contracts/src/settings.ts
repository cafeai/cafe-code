import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL, ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./orchestration.ts";
import { ProviderInstanceConfig, ProviderInstanceId } from "./providerInstance.ts";
import { EditorId } from "./editor.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const ChatCopyFormat = Schema.Literals(["markdown", "plainText"]);
export type ChatCopyFormat = typeof ChatCopyFormat.Type;
export const DEFAULT_CHAT_COPY_FORMAT: ChatCopyFormat = "markdown";

export const DefaultEditorSelection = Schema.Union([Schema.Literal("system-default"), EditorId]);
export type DefaultEditorSelection = typeof DefaultEditorSelection.Type;
export const DEFAULT_DEFAULT_EDITOR: DefaultEditorSelection = "system-default";

export const PowerSaveBlockerMode = Schema.Literals(["off", "during-chats", "always"]);
export type PowerSaveBlockerMode = typeof PowerSaveBlockerMode.Type;
export const DEFAULT_POWER_SAVE_BLOCKER_MODE: PowerSaveBlockerMode = "off";

export const DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS = false;
export const DEFAULT_SHOW_SIDEBAR_SEARCH = true;
export const DEFAULT_SHOW_SIDEBAR_MASCOT = true;
export const DEFAULT_SHOW_SIDEBAR_ATTRIBUTION = true;
export const DEFAULT_BRAND_WORDMARK_PREFIX = "Cafe";
export const DEFAULT_SIDEBAR_BRAND_IMAGE_DATA_URL = "";
export const DEFAULT_SIDEBAR_BRAND_IMAGE = null;
export const DEFAULT_APP_ACCENT_COLOR = "";
export const DEFAULT_THEME_ACCENT_COLOR = "";
export const MIN_SIDEBAR_STAR_SPEED = 0.25;
export const MAX_SIDEBAR_STAR_SPEED = 4;
export const DEFAULT_SIDEBAR_STAR_SPEED = 1;
export const MAX_BRAND_WORDMARK_PREFIX_LENGTH = 64;
export const MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES = 1_000_000;
export const MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH =
  Math.ceil((MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES * 4) / 3) + 128;
export const MAX_SIDEBAR_BRAND_IMAGE_DIMENSION = 4096;
export const MAX_SIDEBAR_BRAND_IMAGE_PIXEL_COUNT = 16_777_216;
export const MAX_SIDEBAR_BRAND_IMAGE_ID_LENGTH = 96;
export const MAX_SIDEBAR_BRAND_IMAGE_URL_LENGTH = 256;
export const SidebarBrandImageId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_SIDEBAR_BRAND_IMAGE_ID_LENGTH),
  Schema.isPattern(/^sha256-[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/),
);
export type SidebarBrandImageId = typeof SidebarBrandImageId.Type;
export const SidebarBrandImageMimeType = Schema.Literals([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export type SidebarBrandImageMimeType = typeof SidebarBrandImageMimeType.Type;
export const SidebarBrandImageAsset = Schema.Struct({
  id: SidebarBrandImageId,
  url: TrimmedNonEmptyString.check(
    Schema.isMaxLength(MAX_SIDEBAR_BRAND_IMAGE_URL_LENGTH),
    Schema.isPattern(
      /^\/api\/branding\/sidebar-image\/sha256-[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/,
    ),
  ),
  mimeType: SidebarBrandImageMimeType,
  width: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_SIDEBAR_BRAND_IMAGE_DIMENSION }),
  ),
  height: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_SIDEBAR_BRAND_IMAGE_DIMENSION }),
  ),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES }),
  ),
});
export type SidebarBrandImageAsset = typeof SidebarBrandImageAsset.Type;
export const SidebarStarSpeed = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_STAR_SPEED,
    maximum: MAX_SIDEBAR_STAR_SPEED,
  }),
);
export type SidebarStarSpeed = typeof SidebarStarSpeed.Type;

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;

export const ClientSettingsSchema = Schema.Struct({
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Per-device: surface system notifications when a thread finishes running
  // (native notifications in the desktop app, Web Push in browsers). Off by
  // default; enabling may prompt for OS-level notification permission.
  notificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  continueBackgroundAnimations: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS)),
  ),
  showSidebarSearch: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SHOW_SIDEBAR_SEARCH)),
  ),
  showSidebarMascot: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SHOW_SIDEBAR_MASCOT)),
  ),
  showSidebarAttribution: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SHOW_SIDEBAR_ATTRIBUTION)),
  ),
  brandWordmarkPrefix: TrimmedString.check(
    Schema.isMaxLength(MAX_BRAND_WORDMARK_PREFIX_LENGTH),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_BRAND_WORDMARK_PREFIX))),
  sidebarBrandImage: Schema.NullOr(SidebarBrandImageAsset).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_BRAND_IMAGE)),
  ),
  // Legacy migration input only. New upload flows store `sidebarBrandImage`
  // metadata while image bytes live in the authenticated server asset store.
  sidebarBrandImageDataUrl: TrimmedString.check(
    Schema.isMaxLength(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_BRAND_IMAGE_DATA_URL))),
  sidebarStarSpeed: SidebarStarSpeed.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_STAR_SPEED)),
  ),
  themeAccentColor: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THEME_ACCENT_COLOR)),
  ),
  appAccentColor: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APP_ACCENT_COLOR)),
  ),
  defaultEditor: DefaultEditorSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DEFAULT_EDITOR)),
  ),
  // Model favorites. Historically keyed by provider kind, now
  // widened to `ProviderInstanceId` so users can favorite a specific model
  // on a custom provider instance (e.g. "Codex Personal · gpt-5") without
  // the UI collapsing it into the same bucket as the default Codex. The
  // widening is backward-compatible by construction: prior provider-kind
  // strings satisfy the `ProviderInstanceId` slug schema, so previously
  // persisted favorites decode unchanged and continue to point at the
  // default instance for their kind (because `defaultInstanceIdForDriver(kind)`
  // uses the same slug). The field name is kept as `provider` for storage
  // stability; new call sites should treat the value as an instance id.
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: Schema.Record(
    ProviderInstanceId,
    Schema.Struct({
      hiddenModels: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefault(Effect.succeed([])),
      ),
      modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  powerSaveBlockerMode: PowerSaveBlockerMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_POWER_SAVE_BLOCKER_MODE)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  chatCopyFormat: ChatCopyFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CHAT_COPY_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

export type ClientSettingsKey = keyof ClientSettings;

export const CLIENT_SETTINGS_KEYS = Object.keys(
  ClientSettingsSchema.fields,
) as ReadonlyArray<ClientSettingsKey>;

export const CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEYS = [
  "defaultEditor",
  "powerSaveBlockerMode",
] as const satisfies ReadonlyArray<ClientSettingsKey>;

const CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEY_SET = new Set<ClientSettingsKey>(
  CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEYS,
);

export function isClientSettingsKey(value: string): value is ClientSettingsKey {
  return CLIENT_SETTINGS_KEYS.includes(value as ClientSettingsKey);
}

export function isCapabilityDependentClientSettingsKey(
  value: ClientSettingsKey,
): value is (typeof CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEYS)[number] {
  return CLIENT_SETTINGS_CAPABILITY_DEPENDENT_KEY_SET.has(value);
}

export const CLIENT_SETTINGS_EXCLUDED_SECRET_STORES = [
  "auth-cookies",
  "bearer-sessions",
  "pairing-bootstrap-tokens",
  "provider-credentials",
  "provider-api-keys",
  "provider-environment-secrets",
  "tls-private-keys",
] as const;

export class ClientSettingsError extends Schema.TaggedErrorClass<ClientSettingsError>()(
  "ClientSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Client settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch";

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Cafe Code Codex runtime home. Shares config/session files while keeping auth and runtime databases isolated.",
        providerSettingsForm: {
          placeholder: "~/.codex-cafecode/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const GeminiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("gemini").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Gemini binary used by this instance.",
        providerSettingsForm: { placeholder: "gemini", clearWhenEmpty: "omit" },
      }),
    ),
    authMethod: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("oauth-personal")),
      Schema.annotateKey({
        title: "Authentication method",
        description: "Gemini ACP authentication method id used during session setup.",
        providerSettingsForm: { placeholder: "oauth-personal", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "authMethod"],
  },
);
export type GeminiSettings = typeof GeminiSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.minutes(5);

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),

  // Legacy single-instance-per-driver settings. Continues to be the source
  // of truth until `providerInstances` (below) lands per-driver migration
  // shims and the server starts hydrating instances from it. Driver-specific
  // schemas live here for the duration of the migration; once each driver
  // owns its config in its own package, this struct shrinks to nothing and
  // is removed entirely.
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // New driver-agnostic instance map. Keyed by `ProviderInstanceId`; values
  // are `ProviderInstanceConfig` envelopes. The driver-specific config blob
  // is `Schema.Unknown` at this layer so envelopes with unknown drivers
  // (forks, downgrades, in-flight PR branches) round-trip without loss.
  // See providerInstance.ts for the forward/backward compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  shadowHomePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(TrimmedString),
  homePath: Schema.optionalKey(TrimmedString),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(TrimmedString),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
    }),
  ),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  // The web UI sends a fully-formed map every time it edits this field.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  notificationsEnabled: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffWordWrap: Schema.optionalKey(Schema.Boolean),
  continueBackgroundAnimations: Schema.optionalKey(Schema.Boolean),
  showSidebarSearch: Schema.optionalKey(Schema.Boolean),
  showSidebarMascot: Schema.optionalKey(Schema.Boolean),
  showSidebarAttribution: Schema.optionalKey(Schema.Boolean),
  brandWordmarkPrefix: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(MAX_BRAND_WORDMARK_PREFIX_LENGTH)),
  ),
  sidebarBrandImageDataUrl: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(MAX_SIDEBAR_BRAND_IMAGE_DATA_URL_LENGTH)),
  ),
  sidebarBrandImage: Schema.optionalKey(Schema.NullOr(SidebarBrandImageAsset)),
  sidebarStarSpeed: Schema.optionalKey(SidebarStarSpeed),
  themeAccentColor: Schema.optionalKey(TrimmedString),
  appAccentColor: Schema.optionalKey(TrimmedString),
  defaultEditor: Schema.optionalKey(DefaultEditorSelection),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderInstanceId,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  providerModelPreferences: Schema.optionalKey(
    Schema.Record(
      ProviderInstanceId,
      Schema.Struct({
        hiddenModels: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
        modelOrder: Schema.Array(Schema.String).pipe(
          Schema.withDecodingDefault(Effect.succeed([])),
        ),
      }),
    ),
  ),
  powerSaveBlockerMode: Schema.optionalKey(PowerSaveBlockerMode),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  chatCopyFormat: Schema.optionalKey(ChatCopyFormat),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
