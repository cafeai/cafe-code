import assert from "node:assert/strict";

import { CodexSettings, ProviderInstanceId } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";

import {
  resolveCodexRuntimeEnvironment,
  resolveCodexShadowHomeAuthSource,
  withDefaultCodexShadowHome,
} from "./CodexDriver.ts";

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

  it("isolates an OSS instance even when it reads configuration from an explicit home", () => {
    const config = decodeCodexSettings({
      ossMode: true,
      homePath: "~/.codex-work",
    });

    const resolved = withDefaultCodexShadowHome({
      instanceId: ProviderInstanceId.make("lmstudio"),
      config,
    });

    assert.equal(resolved.homePath, "~/.codex-work");
    assert.equal(resolved.shadowHomePath, "~/.cafe-code/codex-homes/lmstudio");
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

describe("LM Studio Codex environment", () => {
  it("scopes a normalized LAN endpoint to one OSS instance", () => {
    const config = decodeCodexSettings({
      ossMode: true,
      ossBaseUrl: "http://192.168.20.15:1234/v1/",
    });
    const environment = { EXISTING: "kept" };

    const resolved = resolveCodexRuntimeEnvironment(config, environment);

    assert.equal(resolved.CODEX_OSS_BASE_URL, "http://192.168.20.15:1234/v1");
    assert.equal(resolved.EXISTING, "kept");
    assert.equal("CODEX_OSS_BASE_URL" in environment, false);
  });

  it("does not inject an endpoint into a cloud Codex instance", () => {
    const environment = { EXISTING: "kept" };
    assert.equal(resolveCodexRuntimeEnvironment(decodeCodexSettings({}), environment), environment);
  });

  it("keeps LM Studio shadow homes free of cloud credentials", () => {
    assert.equal(
      resolveCodexShadowHomeAuthSource(
        decodeCodexSettings({ ossMode: true, shadowHomePath: "~/.codex-local" }),
      ),
      "none",
    );
    assert.equal(
      resolveCodexShadowHomeAuthSource(decodeCodexSettings({ shadowHomePath: "~/.codex-work" })),
      "shadow",
    );
  });
});
