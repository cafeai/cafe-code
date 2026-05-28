import { describe, expect, it } from "vitest";

import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transportError";

describe("transportError", () => {
  it("detects websocket transport failures", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: 1006")).toBe(true);
    expect(
      isTransportConnectionErrorMessage("Unable to connect to the Cafe Code server WebSocket."),
    ).toBe(true);
    expect(isTransportConnectionErrorMessage("SocketOpenError: Timeout")).toBe(true);
  });

  it("preserves non-transport thread errors", () => {
    expect(sanitizeThreadErrorMessage("Turn failed")).toBe("Turn failed");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("drops transport failures from thread surfaces", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: 1006")).toBeNull();
  });

  it("drops recoverable Claude resume failures from thread surfaces", () => {
    expect(
      sanitizeThreadErrorMessage(
        "Provider adapter process error (claudeAgent) for thread dcbfea2e-811c-4650-9084-1a0797d8983e: Claude Code returned an error result: No message found with message.uuid of: e3f1e1ef-cb68-4dd6-bc2e-36fff1980fe5",
      ),
    ).toBeNull();
    expect(
      sanitizeThreadErrorMessage(
        "Provider adapter request failed (claudeAgent) for turn/setPermissionMode: No conversation found with session ID: de46e3d3-ad3c-4a82-9995-90f5dbe5c9b8",
      ),
    ).toBeNull();
  });

  it("drops Claude execution diagnostics from thread error surfaces", () => {
    expect(
      sanitizeThreadErrorMessage(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
    ).toBeNull();
    expect(
      sanitizeThreadErrorMessage(
        "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
      ),
    ).toBeNull();
    expect(
      sanitizeThreadErrorMessage(
        "Provider adapter process error (claudeAgent): [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
      ),
    ).toBeNull();
  });
});
