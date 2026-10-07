import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { verifyNativeRuntime } from "@cafecode/shared/nativeRuntime";
import release from "../../../../native/cua-driver/release.json" with { type: "json" };
import policy from "../../../../native/cua-driver/build.json" with { type: "json" };
const require = createRequire(import.meta.url);
// Load the builder's public entry first, as its CLI does, to establish the
// shared Packager classes before importing MacPackager's circular graph.
require("app-builder-lib");
const { MacPackager } = require("app-builder-lib/out/macPackager") as {
  MacPackager: {
    prototype: {
      sign: (...args: unknown[]) => Promise<boolean>;
      doSign: (...args: unknown[]) => Promise<void>;
    };
  };
};
const hook = fileURLToPath(new URL("../../scripts/sign-cua-app.cjs", import.meta.url));

it.skipIf(process.platform !== "darwin" || process.env.CAFE_CODE_CUA_SIGNING_E2E !== "1")(
  "finalizes helper provenance and the app seal inside the real builder signing pipeline before notarization",
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "cafe-cua-sign-"));
    const app = join(root, "Fixture.app");
    const resource = join(app, "Contents/Resources/cua-driver");
    const main = join(app, "Contents/MacOS/fixture");
    const helper = join(resource, "cua-driver");
    const sign = (...args: string[]) =>
      execFileSync("/usr/bin/codesign", args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    try {
      await fs.mkdir(resource, { recursive: true });
      await fs.mkdir(dirname(main));
      await fs.copyFile(process.execPath, main);
      await fs.copyFile(process.execPath, helper);
      await fs.writeFile(
        join(app, "Contents/Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cafe.fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      );
      const before = createHash("sha256")
        .update(await fs.readFile(helper))
        .digest("hex");
      await fs.writeFile(
        join(resource, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          version: release.version,
          sourceCommit: release.sourceCommit,
          patchSha256: policy.patchSha256,
          platform: "darwin",
          arch: process.arch,
          binary: "cua-driver",
          integrationApproved: true,
          sha256: before,
        }),
      );
      const notarize = vi.fn(async () => {
        expect(await verifyNativeRuntime(resource)).toBe(helper);
        expect(
          createHash("sha256")
            .update(await fs.readFile(helper))
            .digest("hex"),
        ).not.toBe(before);
        sign("--verify", "--strict", app);
      });
      const config = { sign: hook };
      const packager = {
        appInfo: { productFilename: "Fixture", type: "module" },
        codeSigningInfo: { value: Promise.resolve({}) },
        info: {
          getWorkspaceRoot: async () => fileURLToPath(new URL("../../../../", import.meta.url)),
        },
        platformSpecificBuildOptions: config,
        doSign: MacPackager.prototype.doSign,
        helper: {
          // No keychain discovery, real signing identity or notarization
          // credential participates. Actual signing is ad-hoc on copied Node.
          findSigningIdentity: async () => ({ name: "-", hash: "-" }),
          buildSignOptions: async () => ({
            app,
            platform: "darwin",
            identity: "-",
            identityValidation: false,
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            optionsForFile: (file: string) => ({
              hardenedRuntime: false,
              additionalArguments: [
                "--identifier",
                file === app ? "com.cafe.fixture" : "com.cafe.fixture.native",
              ],
            }),
          }),
          notarizeIfProvided: notarize,
        },
      };
      expect(await MacPackager.prototype.sign.call(packager, app, root, config, null)).toBe(true);
      expect(notarize).toHaveBeenCalledExactlyOnceWith(app);
      notarize.mockClear();
      // The pinned builder must skip our hook completely for unsigned apps.
      const unsigned = {
        ...packager,
        doSign: vi.fn(MacPackager.prototype.doSign),
        helper: { ...packager.helper, handleNullIdentity: () => false },
      };
      expect(
        await MacPackager.prototype.sign.call(
          unsigned,
          app,
          root,
          { ...config, identity: null },
          null,
        ),
      ).toBe(false);
      expect(unsigned.doSign).not.toHaveBeenCalled();
      expect(notarize).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
