/** Shared by both executable launchers so neither imports the other's entrypoint.
 * Awaiting the macOS launcher while it imports start-electron would leave that
 * entrypoint's top-level await unsettled and exit before LaunchServices runs. */
export function buildDesktopChildEnv(env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.CAFE_CODE_DESKTOP_DEV;
  delete childEnv.VITE_DEV_SERVER_URL;
  delete childEnv.CAFE_CODE_DEV_URL;
  // Headless Linux source launches also need the explicit Debug selection.
  childEnv.CAFE_CODE_DATA_PROFILE = "debug";
  return childEnv;
}
