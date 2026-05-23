import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import { formatSshAgentAuthRequiredMessage, isSshAuthFailure } from "./auth.ts";

describe("ssh auth", () => {
  it.effect("detects ssh auth failures from common permission denied messages", () =>
    Effect.sync(() => {
      assert.equal(
        isSshAuthFailure(
          new Error(
            "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
          ),
        ),
        true,
      );
      assert.equal(isSshAuthFailure(new Error("Permission denied (publickey).")), true);
      assert.equal(isSshAuthFailure(new Error("Connection timed out")), false);
      assert.equal(isSshAuthFailure(new Error("mkdir: Permission denied")), false);
    }),
  );

  it("formats the agent-only SSH auth error", () => {
    assert.equal(
      formatSshAgentAuthRequiredMessage("julius@devbox"),
      [
        "SSH authentication failed for julius@devbox.",
        "Cafe Code requires SSH agent/key authentication.",
        "Load an unlocked key into ssh-agent and verify OpenSSH can connect without a password prompt.",
      ].join(" "),
    );
  });
});
