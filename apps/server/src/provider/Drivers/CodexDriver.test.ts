import assert from "node:assert/strict";

import { CodexSettings, ProviderInstanceId } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";

import { withDefaultCodexShadowHome } from "./CodexDriver.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

describe("withDefaultCodexShadowHome", () => {
  it("isolates the default Codex instance in a Cafe Code shadow home", () => {
    const config = decodeCodexSettings({});

    const resolved = withDefaultCodexShadowHome({
      instanceId: ProviderInstanceId.make("codex"),
      config,
    });

    assert.equal(resolved.homePath, "");
    assert.equal(resolved.shadowHomePath, "~/.cafe-code/codex-homes/codex");
  });

  it("preserves explicit Codex home settings", () => {
    const explicitHome = decodeCodexSettings({ homePath: "~/.codex-work" });
    const explicitShadow = decodeCodexSettings({ shadowHomePath: "~/.codex-cafe-work" });

    assert.equal(
      withDefaultCodexShadowHome({
        instanceId: ProviderInstanceId.make("codex"),
        config: explicitHome,
      }),
      explicitHome,
    );
    assert.equal(
      withDefaultCodexShadowHome({
        instanceId: ProviderInstanceId.make("codex"),
        config: explicitShadow,
      }),
      explicitShadow,
    );
  });

  it("uses stable provider instance ids in default shadow paths", () => {
    const config = decodeCodexSettings({});

    const resolved = withDefaultCodexShadowHome({
      instanceId: ProviderInstanceId.make("codex_personal-prod"),
      config,
    });

    assert.equal(resolved.shadowHomePath, "~/.cafe-code/codex-homes/codex_personal-prod");
  });
});
