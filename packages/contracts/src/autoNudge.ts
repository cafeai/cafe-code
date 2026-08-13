import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, NonNegativeInt, TurnId } from "./baseSchemas.ts";

export const AutoNudgeMode = Schema.Literals(["off", "hardcore-fanout", "steady-progress"]);
export type AutoNudgeMode = typeof AutoNudgeMode.Type;

export const AutoNudgeEnabledMode = Schema.Literals(["hardcore-fanout", "steady-progress"]);
export type AutoNudgeEnabledMode = typeof AutoNudgeEnabledMode.Type;

export const DEFAULT_AUTO_NUDGE_MODE: AutoNudgeMode = "off";
export const DEFAULT_AUTO_NUDGE_BACKGROUND_CONTINUATION = false;
export const MIN_AUTO_NUDGE_MAX_ROUNDS = 1;
export const MAX_AUTO_NUDGE_MAX_ROUNDS = 20;
export const DEFAULT_AUTO_NUDGE_MAX_ROUNDS = 5;
export const THREAD_AUTO_NUDGE_PROMPT_MAX_CHARS = 4_000;
export const THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION = 2_147_483_647;

/**
 * Language used for Club Code-authored automation prompts. `system` is kept
 * deterministic here and falls back to English; the renderer resolves the
 * operating-system locale before calling these helpers when it is available.
 */
export type BuiltInPromptLanguage = "system" | "en" | "ja" | "dual";

export const AUTO_NUDGE_BUILT_IN_PROMPTS: Readonly<Record<AutoNudgeEnabledMode, string>> = {
  "hardcore-fanout": [
    "Continue from the current thread context; do not restart discovery.",
    "Re-anchor to unresolved operator requests and the project's applicable handoff, plan, canon, and current PR/backlog state.",
    "Reconcile external state once per bounded run, then refresh only after a relevant change or when stale.",
    "Drive the highest-priority unblocked asks through bounded, non-overlapping parallel lanes with one owner per lane; never fan out duplicate investigation or implementation.",
    "Give each lane a compact context packet, converge through repository gates and required independent audits, and update canon only when evidence or operator intent requires it.",
    "Linear owns actionable status and dependencies; Notion owns durable decisions and research; link rather than duplicate.",
    "Stop fan-out when lanes contend, context cost exceeds its value, work is complete or blocked, or new authority is required.",
  ].join(" "),
  "steady-progress": [
    "Continue from the current thread context; do not restart discovery or reread settled material.",
    "Re-anchor to unresolved operator requests and the project's applicable handoff, plan, canon, and current PR/backlog state.",
    "Reuse a compact progress packet when present; refresh external state only after a relevant change or when stale.",
    "Select the highest-priority unblocked operator ask, keep at most two coherent lanes, implement the next verifiable slice, and update canon only when evidence or operator intent requires it.",
    "Linear owns actionable status and dependencies; Notion owns durable decisions and research; link rather than duplicate.",
    "Stop and report when the plan is complete, progress is blocked, or new authority is required.",
  ].join(" "),
};

export const AUTO_NUDGE_BUILT_IN_PROMPTS_JAPANESE: Readonly<Record<AutoNudgeEnabledMode, string>> =
  {
    "hardcore-fanout": [
      "現在のスレッドの文脈から作業を続け、調査を最初からやり直さないでください。",
      "未解決のオペレーター要求と、該当するプロジェクトの引き継ぎ事項、計画、規範、現在のPRおよびバックログの状態に照準を戻してください。",
      "区切られた実行ごとに外部状態を一度だけ照合し、その後は関連する変更後または古くなった場合にのみ更新してください。",
      "ブロックされていない最優先の要求を、範囲が限定され重複しない並列レーンで進め、各レーンに担当者を1人だけ置いてください。調査や実装を重複して並列化してはいけません。",
      "各レーンに簡潔なコンテキストパケットを渡し、リポジトリのゲートと必要な独立監査を通して統合し、根拠またはオペレーターの意図によって必要な場合にのみ規範を更新してください。",
      "Linearは実行可能な状態と依存関係を管理し、Notionは永続的な決定事項と調査を管理します。重複させず、リンクしてください。",
      "レーンが競合する、コンテキストのコストが価値を上回る、作業が完了またはブロックされる、あるいは新しい権限が必要になった時点で並列化を停止してください。",
    ].join(""),
    "steady-progress": [
      "現在のスレッドの文脈から作業を続け、調査を最初からやり直したり、確定済みの資料を読み直したりしないでください。",
      "未解決のオペレーター要求と、該当するプロジェクトの引き継ぎ事項、計画、規範、現在のPRおよびバックログの状態に照準を戻してください。",
      "簡潔な進捗パケットがある場合は再利用し、外部状態は関連する変更後または古くなった場合にのみ更新してください。",
      "ブロックされていない最優先のオペレーター要求を選び、一貫した作業レーンは最大2本に保ち、次の検証可能な単位を実装し、根拠またはオペレーターの意図によって必要な場合にのみ規範を更新してください。",
      "Linearは実行可能な状態と依存関係を管理し、Notionは永続的な決定事項と調査を管理します。重複させず、リンクしてください。",
      "計画が完了した、進行がブロックされた、または新しい権限が必要になった時点で停止して報告してください。",
    ].join(""),
  };

export const AUTO_NUDGE_BUILT_IN_PROMPTS_DUAL: Readonly<Record<AutoNudgeEnabledMode, string>> = {
  "hardcore-fanout": `${AUTO_NUDGE_BUILT_IN_PROMPTS["hardcore-fanout"]}\n\n${AUTO_NUDGE_BUILT_IN_PROMPTS_JAPANESE["hardcore-fanout"]}`,
  "steady-progress": `${AUTO_NUDGE_BUILT_IN_PROMPTS["steady-progress"]}\n\n${AUTO_NUDGE_BUILT_IN_PROMPTS_JAPANESE["steady-progress"]}`,
};

export const AUTO_NUDGE_BUILT_IN_PROMPTS_BY_LANGUAGE: Readonly<
  Record<Exclude<BuiltInPromptLanguage, "system">, Readonly<Record<AutoNudgeEnabledMode, string>>>
> = {
  en: AUTO_NUDGE_BUILT_IN_PROMPTS,
  ja: AUTO_NUDGE_BUILT_IN_PROMPTS_JAPANESE,
  dual: AUTO_NUDGE_BUILT_IN_PROMPTS_DUAL,
};

export function autoNudgeBuiltInPromptsForLanguage(
  language: BuiltInPromptLanguage = "en",
): Readonly<Record<AutoNudgeEnabledMode, string>> {
  return AUTO_NUDGE_BUILT_IN_PROMPTS_BY_LANGUAGE[language === "system" ? "en" : language];
}

export function autoNudgeBuiltInPromptForLanguage(
  mode: AutoNudgeEnabledMode,
  language: BuiltInPromptLanguage = "en",
): string {
  return autoNudgeBuiltInPromptsForLanguage(language)[mode];
}

export const LEGACY_AUTO_NUDGE_BUILT_IN_PROMPTS: Readonly<
  Record<AutoNudgeEnabledMode, readonly string[]>
> = {
  "hardcore-fanout": ["Fan out and keep going"],
  "steady-progress": ["Keep a few lanes going, make steady progress"],
};

const autoNudgeBuiltInPromptModes = new Map<string, AutoNudgeEnabledMode>([
  ...Object.values(AUTO_NUDGE_BUILT_IN_PROMPTS_BY_LANGUAGE).flatMap((prompts) =>
    Object.entries(prompts).map(
      ([mode, prompt]) => [prompt, mode as AutoNudgeEnabledMode] as const,
    ),
  ),
  ...Object.entries(LEGACY_AUTO_NUDGE_BUILT_IN_PROMPTS).flatMap(([mode, prompts]) =>
    prompts.map((prompt) => [prompt, mode as AutoNudgeEnabledMode] as const),
  ),
]);

/**
 * Upgrades only recognized Club Code defaults. Operator-authored text is
 * returned exactly as supplied.
 */
export function normalizeAutoNudgeBuiltInPrompt(
  mode: AutoNudgeEnabledMode,
  prompt: string,
  language: BuiltInPromptLanguage = "en",
): string {
  const trimmed = prompt.trim();
  return trimmed.length === 0 || autoNudgeBuiltInPromptModes.has(trimmed)
    ? autoNudgeBuiltInPromptForLanguage(mode, language)
    : prompt;
}

export function migrateStoredAutoNudgeBuiltInPrompt(
  mode: AutoNudgeMode,
  prompt: string,
  language: BuiltInPromptLanguage = "en",
): string {
  const sourceMode = autoNudgeBuiltInPromptModes.get(prompt.trim());
  if (sourceMode === undefined) {
    return prompt;
  }
  return autoNudgeBuiltInPromptForLanguage(mode === "off" ? sourceMode : mode, language);
}

export const AutoNudgeMaxRounds = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AUTO_NUDGE_MAX_ROUNDS,
    maximum: MAX_AUTO_NUDGE_MAX_ROUNDS,
  }),
);
export type AutoNudgeMaxRounds = typeof AutoNudgeMaxRounds.Type;

export const ThreadAutoNudgeAuthorityRevision = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION),
);
export type ThreadAutoNudgeAuthorityRevision = typeof ThreadAutoNudgeAuthorityRevision.Type;

export const GlobalAutoNudgeAuthorityRevision = ThreadAutoNudgeAuthorityRevision;
export type GlobalAutoNudgeAuthorityRevision = typeof GlobalAutoNudgeAuthorityRevision.Type;

export const GlobalAutoNudgeAuthority = Schema.Union([
  Schema.Struct({
    authorityRevision: GlobalAutoNudgeAuthorityRevision,
    status: Schema.Literal("allowed"),
    stoppedAt: Schema.Null,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    authorityRevision: GlobalAutoNudgeAuthorityRevision,
    status: Schema.Literal("stopped"),
    stoppedAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }),
]);
export type GlobalAutoNudgeAuthority = typeof GlobalAutoNudgeAuthority.Type;

export const DEFAULT_GLOBAL_AUTO_NUDGE_AUTHORITY: GlobalAutoNudgeAuthority = {
  authorityRevision: 0,
  status: "allowed",
  stoppedAt: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export const GlobalAutoNudgeAuthorityWithDefault = GlobalAutoNudgeAuthority.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLOBAL_AUTO_NUDGE_AUTHORITY)),
);

/**
 * User-authored Auto Nudge text. Newlines are intentionally valid, while an
 * all-whitespace prompt is not. The prompt is persisted only on the exact
 * thread detail projection and is never accepted on an automated dispatch
 * command.
 */
export const ThreadAutoNudgePrompt = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(THREAD_AUTO_NUDGE_PROMPT_MAX_CHARS),
  Schema.isPattern(/\S/),
);
export type ThreadAutoNudgePrompt = typeof ThreadAutoNudgePrompt.Type;

export const StoredThreadAutoNudgePrompt = Schema.String.check(
  Schema.isMaxLength(THREAD_AUTO_NUDGE_PROMPT_MAX_CHARS),
);
export type StoredThreadAutoNudgePrompt = typeof StoredThreadAutoNudgePrompt.Type;

const ThreadAutoNudgeRunFields = {
  authorityRevision: ThreadAutoNudgeAuthorityRevision,
  // Configurations written before the global authority existed belong to
  // generation zero. The server rejects them after the first global change.
  globalAuthorityRevision: Schema.optional(GlobalAutoNudgeAuthorityRevision),
  backgroundContinuation: Schema.Boolean,
  maxRounds: AutoNudgeMaxRounds,
  baselineSettledTurnId: Schema.NullOr(TurnId),
  lastDispatchedSettledTurnId: Schema.NullOr(TurnId),
  // The user message the last dispatch injected. The turn that message starts
  // is Auto Nudge's own work: without background continuation its completion
  // must never authorize the next dispatch, or one nudge chains into a paid
  // nudge loop. Decoding default keeps configurations persisted before this
  // field valid.
  lastDispatchedMessageId: Schema.NullOr(MessageId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  roundsDispatched: NonNegativeInt,
  lastDispatchedAt: Schema.NullOr(IsoDateTime),
} as const;

const ThreadAutoNudgeOffConfig = Schema.Struct({
  ...ThreadAutoNudgeRunFields,
  mode: Schema.Literal("off"),
  prompt: StoredThreadAutoNudgePrompt,
  armedAt: Schema.Null,
});

const ThreadAutoNudgeEnabledConfig = Schema.Struct({
  ...ThreadAutoNudgeRunFields,
  mode: AutoNudgeEnabledMode,
  prompt: ThreadAutoNudgePrompt,
  armedAt: IsoDateTime,
});

/**
 * Server-authoritative execution authority for one exact thread.
 *
 * `authorityRevision` changes whenever configuration authority is replaced or
 * stopped. `baselineSettledTurnId` prevents enabling/editing a configuration
 * from retroactively dispatching against a turn that was already complete.
 */
export const ThreadAutoNudgeConfig = Schema.Union([
  ThreadAutoNudgeOffConfig,
  ThreadAutoNudgeEnabledConfig,
]);
export type ThreadAutoNudgeConfig = typeof ThreadAutoNudgeConfig.Type;

/**
 * Prompt-free shell representation. It is safe to fan out to shell
 * subscribers and contains only the state required to schedule a revision-
 * checked server dispatch.
 */
export const ThreadAutoNudgeSummary = Schema.Struct({
  ...ThreadAutoNudgeRunFields,
  mode: AutoNudgeMode,
  armedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadAutoNudgeSummary = typeof ThreadAutoNudgeSummary.Type;

export const DEFAULT_THREAD_AUTO_NUDGE_CONFIG: ThreadAutoNudgeConfig = {
  authorityRevision: 0,
  mode: "off",
  prompt: "",
  backgroundContinuation: false,
  maxRounds: DEFAULT_AUTO_NUDGE_MAX_ROUNDS,
  armedAt: null,
  baselineSettledTurnId: null,
  lastDispatchedSettledTurnId: null,
  lastDispatchedMessageId: null,
  roundsDispatched: 0,
  lastDispatchedAt: null,
};

export const ThreadAutoNudgeConfigWithDefault = ThreadAutoNudgeConfig.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_AUTO_NUDGE_CONFIG)),
);

export const DEFAULT_THREAD_AUTO_NUDGE_SUMMARY: ThreadAutoNudgeSummary = {
  authorityRevision: 0,
  globalAuthorityRevision: 0,
  mode: "off",
  backgroundContinuation: false,
  maxRounds: DEFAULT_AUTO_NUDGE_MAX_ROUNDS,
  armedAt: null,
  baselineSettledTurnId: null,
  lastDispatchedSettledTurnId: null,
  lastDispatchedMessageId: null,
  roundsDispatched: 0,
  lastDispatchedAt: null,
};

export const ThreadAutoNudgeSummaryWithDefault = ThreadAutoNudgeSummary.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_AUTO_NUDGE_SUMMARY)),
);

export const ThreadAutoNudgeDispatchSource = Schema.Literals(["foreground", "background"]);
export type ThreadAutoNudgeDispatchSource = typeof ThreadAutoNudgeDispatchSource.Type;
