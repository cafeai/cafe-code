import { assert, describe, it } from "@effect/vitest";

import {
  CAFE_CODE_LINUX_PASSWORD_STORE_ENV,
  resolveLinuxSafeStoragePasswordStore,
} from "./LinuxSafeStorageCommandLine.ts";

describe("resolveLinuxSafeStoragePasswordStore", () => {
  it("selects KWallet 6 for Plasma 6 sessions", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        XDG_CURRENT_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      }),
      "kwallet6",
    );
  });

  it("selects KWallet 5 for Plasma 5 sessions", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        DESKTOP_SESSION: "plasma",
        KDE_SESSION_VERSION: "5",
      }),
      "kwallet5",
    );
  });

  it("defaults KDE sessions without a version hint to KWallet 6", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        XDG_SESSION_DESKTOP: "KDE",
      }),
      "kwallet6",
    );
  });

  it("selects libsecret for GNOME-family sessions", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        XDG_CURRENT_DESKTOP: "GNOME",
      }),
      "gnome-libsecret",
    );
  });

  it("selects libsecret for XFCE sessions", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        XDG_SESSION_DESKTOP: "xfce",
      }),
      "gnome-libsecret",
    );
  });

  it("leaves unknown sessions on Electron's automatic backend", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
      undefined,
    );
  });

  it("allows explicit overrides for unusual Linux secret-store setups", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        [CAFE_CODE_LINUX_PASSWORD_STORE_ENV]: "gnome-libsecret",
        XDG_CURRENT_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      }),
      "gnome-libsecret",
    );
  });

  it("allows explicitly returning to Electron's automatic selection", () => {
    assert.equal(
      resolveLinuxSafeStoragePasswordStore({
        [CAFE_CODE_LINUX_PASSWORD_STORE_ENV]: "auto",
        XDG_CURRENT_DESKTOP: "KDE",
        KDE_SESSION_VERSION: "6",
      }),
      undefined,
    );
  });
});
