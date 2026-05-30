import { assert, describe, it } from "@effect/vitest";

import { CAFE_CODE_SHELL_ENV_HYDRATED } from "@cafecode/shared/shell";
import { fixPath } from "./os-jank.ts";

describe("fixPath", () => {
  it("skips blocking shell probes for desktop-hydrated child processes", () => {
    const env: NodeJS.ProcessEnv = {
      [CAFE_CODE_SHELL_ENV_HYDRATED]: "1",
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
    };
    let readPathCallCount = 0;
    let launchctlCallCount = 0;

    fixPath({
      env,
      platform: "darwin",
      readPath: () => {
        readPathCallCount += 1;
        return "/opt/homebrew/bin:/usr/bin";
      },
      readLaunchctlPath: () => {
        launchctlCallCount += 1;
        return "/opt/homebrew/bin:/usr/bin";
      },
      logWarning: () => {
        throw new Error("desktop-hydrated children should not warn during PATH repair");
      },
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(readPathCallCount, 0);
    assert.equal(launchctlCallCount, 0);
  });

  it("still hydrates direct POSIX server launches", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
    };

    fixPath({
      env,
      platform: "darwin",
      readPath: () => "/opt/homebrew/bin:/usr/bin",
    });

    assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
  });
});
