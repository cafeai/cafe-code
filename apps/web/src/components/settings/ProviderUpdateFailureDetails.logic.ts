import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUpdateState,
  ServerProviderUpdateDiagnostics,
} from "@cafecode/contracts";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";

/** This is display text, never terminal/HTML/Markdown input. Both the received
 * text and the escaped representation have a finite 10,000 UTF-16-unit bound.
 * Escape directional formatting and nonprinting controls rather than allowing
 * received output to obscure the adjacent native UI. Preserve ordinary Unicode,
 * tab and newline text; this is not a credential-redaction claim. */
export function providerUpdateOutputForDisplay(value: string): {
  readonly text: string;
  readonly controlsEscaped: boolean;
  readonly displayTruncated: boolean;
} {
  const input = value.slice(0, 10_000);
  let text = "";
  let consumed = 0;
  let controlsEscaped = false;
  for (const character of input) {
    const point = character.codePointAt(0)!;
    const control =
      (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x061c ||
      point === 0x200e ||
      point === 0x200f ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069);
    const rendered = control ? "\\u{" + point.toString(16).toUpperCase() + "}" : character;
    if (text.length + rendered.length > 10_000) break;
    consumed += character.length;
    controlsEscaped ||= control;
    text += rendered;
  }
  return { text, controlsEscaped, displayTruncated: consumed < value.length };
}

export interface FailureSnapshot {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ServerProvider["driver"];
  readonly state: ServerProviderUpdateState;
}

/** Capture only primitive values into new owned objects. Never alias or freeze
 * incoming props: mutation of a received state/diagnostic object must not move
 * both sides of the reveal comparison to a different attempt or output. */
export function captureProviderUpdateFailure(snapshot: FailureSnapshot): FailureSnapshot {
  const state = snapshot.state;
  const diagnostics = state.diagnostics;
  return Object.freeze({
    environmentId: snapshot.environmentId,
    instanceId: snapshot.instanceId,
    driver: snapshot.driver,
    state: Object.freeze({
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      message: state.message,
      output: state.output,
      ...(diagnostics === undefined
        ? {}
        : {
            diagnostics: Object.freeze({
              phase: diagnostics.phase,
              category: diagnostics.category,
              exitCode: diagnostics.exitCode,
              timedOut: diagnostics.timedOut,
              stdoutTruncated: diagnostics.stdoutTruncated,
              stderrTruncated: diagnostics.stderrTruncated,
              outputTruncated: diagnostics.outputTruncated,
            }),
          }),
    }),
  });
}

/** No reveal follows a different instance, attempt, or changed output. Exact
 * value comparison retains an intentional reveal across identical snapshots
 * from harmless status polling, without hashing or serializing private text. */
export function sameProviderUpdateFailure(left: FailureSnapshot, right: FailureSnapshot): boolean {
  const a = left.state;
  const b = right.state;
  const ad = a.diagnostics;
  const bd = b.diagnostics;
  return (
    left.environmentId === right.environmentId &&
    left.instanceId === right.instanceId &&
    left.driver === right.driver &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.message === b.message &&
    a.output === b.output &&
    ((ad === undefined && bd === undefined) ||
      (ad !== undefined &&
        bd !== undefined &&
        ad.phase === bd.phase &&
        ad.category === bd.category &&
        ad.exitCode === bd.exitCode &&
        ad.timedOut === bd.timedOut &&
        ad.outputTruncated === bd.outputTruncated &&
        ad.stdoutTruncated === bd.stdoutTruncated &&
        ad.stderrTruncated === bd.stderrTruncated))
  );
}

export function providerUpdatePhaseLabel(
  phase: ServerProviderUpdateDiagnostics["phase"],
  locale: UiLocale,
): string {
  switch (phase) {
    case "preflight":
      return uiText("Preparing the update", undefined, undefined, locale);
    case "command":
      return uiText("Running the update command", undefined, undefined, locale);
    case "verification":
      return uiText("Checking the installed version", undefined, undefined, locale);
    case "lifecycle":
      return uiText("Managing the update", undefined, undefined, locale);
  }
}

export function providerUpdateCategoryLabel(
  category: ServerProviderUpdateDiagnostics["category"],
  locale: UiLocale,
): string {
  switch (category) {
    case "preflight_failed":
      return uiText("Update preparation failed", undefined, undefined, locale);
    case "command_failed":
      return uiText("The update command failed", undefined, undefined, locale);
    case "command_timed_out":
      return uiText("The update command timed out", undefined, undefined, locale);
    case "runtime_check_failed":
      return uiText("The provider runtime check failed", undefined, undefined, locale);
    case "version_unverified":
      return uiText("The updated version could not be verified", undefined, undefined, locale);
    case "unexpected_failure":
      return uiText("The update could not finish", undefined, undefined, locale);
    case "interrupted":
      return uiText("The update was interrupted", undefined, undefined, locale);
  }
}
