import { assert, describe, it } from "@effect/vitest";

import {
  CAFE_CODE_LINUX_PASSWORD_STORE_ENV,
  resolveLinuxSafeStoragePasswordStore,
} from "./LinuxSafeStorageCommandLine.ts";

describe("resolveLinuxSafeStoragePasswordStore", () => {
  const scenarios = [
    {
      name: "selects KWallet 6 for Plasma 6 sessions",
      env: { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" },
      expected: "kwallet6",
    },
    {
      name: "selects KWallet 5 for Plasma 5 sessions",
      env: { DESKTOP_SESSION: "plasma", KDE_SESSION_VERSION: "5" },
      expected: "kwallet5",
    },
    {
      name: "defaults KDE sessions without a version hint to KWallet 6",
      env: { XDG_SESSION_DESKTOP: "KDE" },
      expected: "kwallet6",
    },
    {
      name: "selects libsecret for GNOME-family sessions",
      env: { XDG_CURRENT_DESKTOP: "GNOME" },
      expected: "gnome-libsecret",
    },
    {
      name: "selects libsecret for XFCE sessions",
      env: { XDG_SESSION_DESKTOP: "xfce" },
      expected: "gnome-libsecret",
    },
    {
      name: "leaves unknown sessions on Electron's automatic backend",
      env: { VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" },
      expected: undefined,
    },
    {
      name: "allows explicit overrides for unusual Linux secret-store setups",
      env: {
        [CAFE_CODE_LINUX_PASSWORD_STORE_ENV]: "gnome-libsecret",
        XDG_CURRENT_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      },
      expected: "gnome-libsecret",
    },
    {
      name: "allows explicitly returning to Electron's automatic selection",
      env: {
        [CAFE_CODE_LINUX_PASSWORD_STORE_ENV]: "auto",
        XDG_CURRENT_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      },
      expected: undefined,
    },
  ] as const;

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      assert.equal(resolveLinuxSafeStoragePasswordStore(scenario.env), scenario.expected);
    });
  }
});
