import { createHash } from "node:crypto";
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type ProviderInstanceId,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ServerProviderModel,
  ProviderTurnConfiguration,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@cafecode/shared/model";
import * as Schema from "effect/Schema";

const decodeConfiguration = Schema.decodeUnknownOption(ProviderTurnConfiguration);
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

function safeLabel(value: unknown, maxChars = 200): string | undefined {
  if (typeof value !== "string" || value.length > maxChars || CONTROL_CHARACTERS.test(value))
    return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxChars ? trimmed : undefined;
}

export function providerTurnAccountFallback(provider: string, instanceId: string): string {
  const driver =
    provider === "codex"
      ? "Codex"
      : provider === "claudeAgent"
        ? "Claude"
        : provider === "opencode"
          ? "OpenCode"
          : provider === "grok"
            ? "Grok"
            : provider;
  return instanceId === provider ? driver : `${driver} · ${instanceId}`;
}

/**
 * Copy only the options that Cafe understands into a finite public snapshot.
 * The session and exact request are captured before provider I/O, so delayed
 * ACKs/account renames cannot retroactively recolor historical turns. A live
 * steer never consumes a newly edited model selection from the composer.
 */
export function snapshotProviderTurnConfiguration(input: {
  readonly session: ProviderSession;
  readonly request: ProviderSendTurnInput;
  readonly instanceId: ProviderInstanceId;
  readonly providerDisplayName?: string | undefined;
  readonly models?: ReadonlyArray<ServerProviderModel> | undefined;
  readonly settingsSource: "submitted" | "session";
}): ProviderTurnConfiguration | undefined {
  const { session, request, instanceId } = input;
  if (session.providerInstanceId !== instanceId) return undefined;
  // An omitted selection leaves the provider on its already admitted session
  // selection. Preserve that known same-account value, but never merge old
  // options into a new explicitly submitted selection with omitted overrides.
  const usesSessionSelection =
    input.settingsSource === "session" || request.modelSelection === undefined;
  const selection = usesSessionSelection
    ? session.modelSelection?.instanceId === instanceId
      ? session.modelSelection
      : undefined
    : request.modelSelection?.instanceId === instanceId
      ? request.modelSelection
      : undefined;
  const model = safeLabel(
    input.settingsSource === "session"
      ? (session.model ?? selection?.model)
      : (selection?.model ?? session.model),
  );
  // Provider-specific option ids are deliberately not interchangeable. In
  // particular, an OpenCode variant is not a Codex reasoning-effort override.
  const effortKey =
    session.provider === "codex" || session.provider === "grok"
      ? "reasoningEffort"
      : session.provider === "opencode"
        ? "variant"
        : session.provider === "claudeAgent"
          ? "effort"
          : undefined;
  const effort = safeLabel(
    effortKey === undefined ? undefined : getModelSelectionStringOptionValue(selection, effortKey),
    80,
  );
  const modelDisplayName = safeLabel(input.models?.find((entry) => entry.slug === model)?.name);
  const fastMode =
    session.provider === "codex" || session.provider === "claudeAgent"
      ? getModelSelectionBooleanOptionValue(selection, "fastMode")
      : undefined;
  // Ultracode is a requested native workflow flag, not another effort level.
  // Capture explicit false as well as true; absence continues to delegate to
  // the native runtime and must not claim account/workflow eligibility.
  const ultracode =
    session.provider === "claudeAgent"
      ? getModelSelectionBooleanOptionValue(selection, "ultracode")
      : undefined;
  const serviceTier =
    session.provider === "codex"
      ? safeLabel(getModelSelectionStringOptionValue(selection, "serviceTier"), 64)
      : undefined;
  const interactionMode =
    input.settingsSource === "session"
      ? session.interactionMode
      : (request.interactionMode ?? session.interactionMode);
  const decoded = decodeConfiguration({
    version: 1,
    provider: session.provider,
    providerInstanceId: instanceId,
    providerDisplayName:
      safeLabel(input.providerDisplayName) ??
      providerTurnAccountFallback(session.provider, instanceId),
    ...(model !== undefined ? { model } : {}),
    ...(modelDisplayName !== undefined ? { modelDisplayName } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(ultracode !== undefined ? { ultracode } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    runtimeMode: session.runtimeMode,
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    // A request can inherit its model options while explicitly submitting a
    // new interaction mode. Do not label that mixed snapshot as wholly native
    // session settings; the submitted authority still owns that mode change.
    settingsSource:
      usesSessionSelection && request.interactionMode === undefined
        ? "session"
        : input.settingsSource,
  });
  return decoded._tag === "Some" ? decoded.value : undefined;
}

/**
 * One turn has one configuration fact. Stable identities make retries/replay
 * reuse the first accepted snapshot, not overwrite it with a later account
 * rename or steer. Hash an unambiguous tuple so user-controlled ids cannot
 * collide through delimiters or become an unbounded command/activity label.
 */
export function providerTurnConfigurationCommand(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly configuration: ProviderTurnConfiguration;
  readonly createdAt: string;
}): OrchestrationCommand {
  const digest = createHash("sha256")
    .update("cafecode/provider-turn-configuration/v1\u0000")
    .update(JSON.stringify([input.threadId, input.configuration.providerInstanceId, input.turnId]))
    .digest("hex");
  return {
    type: "thread.activity.append",
    commandId: CommandId.make(`provider-turn-configuration:${digest}`),
    threadId: input.threadId,
    activity: {
      id: EventId.make(`provider-turn-configuration:${digest}`),
      tone: "info",
      kind: "provider.turn.configuration",
      summary: "Turn settings",
      payload: { turnConfiguration: input.configuration },
      turnId: input.turnId,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}
