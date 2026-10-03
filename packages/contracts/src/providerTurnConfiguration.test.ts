import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ProviderTurnConfiguration } from "./providerTurnConfiguration.ts";

const decode = Schema.decodeUnknownSync(ProviderTurnConfiguration);
const snapshot = {
  version: 1,
  provider: "codex",
  providerInstanceId: "codex_work",
  providerDisplayName: "Codex Work",
  model: "gpt-6.1-sol",
  effort: "ultra",
  fastMode: false,
  runtimeMode: "full-access",
  interactionMode: "default",
  settingsSource: "submitted",
};

describe("ProviderTurnConfiguration", () => {
  it("preserves explicit Fast off and leaves provider defaults absent", () => {
    expect(decode(snapshot)).toEqual(snapshot);
    const { effort: _effort, fastMode: _fastMode, ...defaults } = snapshot;
    expect(decode(defaults)).toEqual(defaults);
  });

  it("rejects oversized, multiline, control/bidi and unsupported envelopes", () => {
    for (const invalid of [
      { ...snapshot, version: 2 },
      { ...snapshot, providerDisplayName: "a".repeat(201) },
      { ...snapshot, providerDisplayName: "Work\nAccount" },
      { ...snapshot, providerDisplayName: "\nWork" },
      { ...snapshot, providerDisplayName: "Work\u2028Account" },
      { ...snapshot, providerDisplayName: "Work\u200e" },
      { ...snapshot, model: "gpt-6.1-sol\u202e" },
      { ...snapshot, effort: "x".repeat(81) },
      { ...snapshot, effort: "ultra\u0000" },
      { ...snapshot, settingsSource: "guessed" },
      { ...snapshot, fastMode: "false" },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  it("drops unrelated auth/config/prompt fields rather than persisting them", () => {
    expect(decode({ ...snapshot, auth: { token: "private" }, prompt: "private" })).toEqual(
      snapshot,
    );
  });
});
