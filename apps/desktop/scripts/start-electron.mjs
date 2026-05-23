import { spawn } from "node:child_process";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.CAFE_CODE_DESKTOP_DEV;
delete childEnv.VITE_DEV_SERVER_URL;
delete childEnv.CAFE_CODE_DEV_URL;

const child = spawn(resolveElectronPath(), ["dist-electron/main.cjs", ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
