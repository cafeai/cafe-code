const path = require("node:path");
const { sign } = require("app-builder-lib/out/codeSign/macCodeSign");
const finalize = require("./finalize-cua-signing.cjs");

// electron-builder 26.15.3 notarizes inside MacPackager.sign, before afterSign.
// Delegate its ordinary signing policy, then finalize native provenance before
// returning to that notarization step. Unsigned builds never invoke mac.sign.
module.exports = async function signCuaApp(options, packager) {
  await sign(options);
  await finalize({ appOutDir: path.dirname(options.app), packager });
};
