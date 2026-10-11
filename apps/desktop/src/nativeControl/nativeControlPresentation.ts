import { uiText } from "@cafecode/shared/i18n";

/**
 * Host status is also evidence returned to provider tools. Translate only the
 * renderer-facing copy at this finite presentation boundary; never mutate the
 * host's stored detail, tool errors or an unknown received diagnostic string.
 */
export function nativeControlDetailForUi(detail: string): string {
  switch (detail) {
    case "Enable local desktop control to connect Codex and Claude.":
      return uiText("Enable local desktop control to connect Codex and Claude.");
    case "Local control is ready. Start a new Codex or Claude session, or normally stop/resume an existing one, to attach desktop tools.":
      return uiText(
        "Local control is ready. Start a new Codex or Claude session, or normally stop/resume an existing one, to attach desktop tools.",
      );
    case "Could not start the reviewed Cua runtime. Prepare it, then check native permissions and try again.":
      return uiText(
        "Could not start the reviewed Cua runtime. Prepare it, then check native permissions and try again.",
      );
    case "Local desktop control is off.":
      return uiText("Local desktop control is off.");
    case "Native controller cleanup remains incomplete. Restart Cafe before using desktop control.":
      return uiText(
        "Native controller cleanup remains incomplete. Restart Cafe before using desktop control.",
      );
    case "Native cleanup could not be acknowledged. The controller was stopped; no input was replayed.":
      return uiText(
        "Native cleanup could not be acknowledged. The controller was stopped; no input was replayed.",
      );
    case "The native action's completion is uncertain. The controller was stopped; inspect the desktop before retrying.":
      return uiText(
        "The native action''s completion is uncertain. The controller was stopped; inspect the desktop before retrying.",
      );
    case "Desktop input lost its response. The controller was stopped; inspect the desktop before retrying.":
      return uiText(
        "Desktop input lost its response. The controller was stopped; inspect the desktop before retrying.",
      );
    default:
      return detail;
  }
}
