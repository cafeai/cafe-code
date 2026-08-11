import { useEffect, useRef } from "react";

import {
  createAtmosphereUsageActivityState,
  observeAtmosphereUsageSnapshot,
  readAtmosphereUsageActivity,
  resetAtmosphereUsageActivity,
  resolveAtmosphereUsageModulation,
  resolveUsageReactiveCapacityDensity,
} from "../atmosphereUsageActivity";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useServerConfig } from "../rpc/serverState";
import {
  advanceAtmosphereSceneInPlace,
  calculateAtmosphereParticleCount,
  createAtmosphereScene,
  createSeededRandom,
  drawAtmosphereScene,
  fitAtmosphereDpr,
  resolveAtmosphereColor,
  resolveMatrixAtmosphereColorFrame,
  shouldAnimateAtmosphere,
  type AtmosphereScene,
} from "../windowAtmosphere";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function sceneSeed(kind: "snow" | "rain" | "matrix", width: number, height: number): number {
  const kindSeed = kind === "snow" ? 0x534e4f57 : kind === "rain" ? 0x5241494e : 0x4d415458;
  return (kindSeed ^ Math.round(width * 31) ^ Math.round(height * 131)) >>> 0;
}

function resolveCanvasDimension(measured: number, viewportFallback: number): number {
  if (Number.isFinite(measured) && measured > 0) return measured;
  if (Number.isFinite(viewportFallback) && viewportFallback > 0) return viewportFallback;
  return 1;
}

export function WindowAtmosphere() {
  const enabled = useSettings((settings) => settings.fallingEffectsEnabled);
  const kind = useSettings((settings) => settings.fallingEffectKind);
  const configuredColor = useSettings((settings) => settings.fallingEffectColor);
  const matrixColorMode = useSettings((settings) => settings.fallingEffectMatrixColorMode);
  const opacity = useSettings((settings) => settings.fallingEffectOpacity);
  const speed = useSettings((settings) => settings.fallingEffectSpeed);
  const density = useSettings((settings) => settings.fallingEffectDensity);
  const usageReactive = useSettings((settings) => settings.fallingEffectUsageReactive);
  const japaneseRatio = useSettings((settings) => settings.fallingEffectJapaneseRatio);
  const continueBackgroundAnimations = useSettings(
    (settings) => settings.continueBackgroundAnimations,
  );
  const { resolvedTheme } = useTheme();
  const serverConfig = useServerConfig();
  const atmosphereAvailable = serverConfig?.ambientExperienceCapabilities.atmosphere === true;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const usageActivityStateRef = useRef(createAtmosphereUsageActivityState());

  useEffect(() => {
    const activityState = usageActivityStateRef.current;
    resetAtmosphereUsageActivity(activityState, Date.now());
    if (
      !atmosphereAvailable ||
      !enabled ||
      !usageReactive ||
      (kind !== "rain" && kind !== "snow")
    ) {
      return;
    }

    const connection = getPrimaryEnvironmentConnection();
    const unsubscribe = connection.client.server.subscribeUsageStats((snapshot) => {
      observeAtmosphereUsageSnapshot(activityState, snapshot, Date.now());
    });
    return () => {
      unsubscribe();
      resetAtmosphereUsageActivity(activityState, Date.now());
    };
  }, [atmosphereAvailable, enabled, kind, usageReactive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!atmosphereAvailable || !enabled || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
    let scene: AtmosphereScene | null = null;
    let animationFrame: number | null = null;
    let resizeFrame: number | null = null;
    let lastFrameTime: number | null = null;
    let baseFallingParticleCount = 0;

    const cancelAnimation = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      lastFrameTime = null;
    };

    const clearCanvasBitmap = () => {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.restore();
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = resolveCanvasDimension(bounds.width, window.innerWidth);
      const height = resolveCanvasDimension(bounds.height, window.innerHeight);
      const requestedDpr = fitAtmosphereDpr(window.devicePixelRatio, width, height);
      const bitmapWidth = Math.max(1, Math.floor(width * requestedDpr));
      const bitmapHeight = Math.max(1, Math.floor(height * requestedDpr));
      const dpr = Math.min(bitmapWidth / width, bitmapHeight / height);
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      baseFallingParticleCount = calculateAtmosphereParticleCount(kind, width, height, density);
      const capacityDensity =
        usageReactive && (kind === "rain" || kind === "snow")
          ? resolveUsageReactiveCapacityDensity(density)
          : density;
      scene = createAtmosphereScene(
        kind,
        width,
        height,
        createSeededRandom(sceneSeed(kind, width, height)),
        capacityDensity,
        japaneseRatio,
      );
    };

    const renderScene = (timestamp: number, advance: boolean) => {
      if (!scene) return;
      const elapsedSeconds =
        advance && lastFrameTime !== null ? (timestamp - lastFrameTime) / 1_000 : 0;
      lastFrameTime = timestamp;
      const usageActivity = readAtmosphereUsageActivity(usageActivityStateRef.current, Date.now());
      const usageModulation = resolveAtmosphereUsageModulation({
        baseParticleCount: baseFallingParticleCount,
        baseSpeed: speed,
        capacityParticleCount: scene.particles.length,
        enabled: usageReactive,
        intensity: usageActivity.intensity,
        kind,
      });
      canvas.dataset.atmosphereUsageReactive = usageReactive ? "true" : "false";
      canvas.dataset.atmosphereUsageTokensPerSecond = usageActivity.tokensPerSecond.toFixed(1);
      canvas.dataset.atmosphereUsageIntensity = usageActivity.intensity.toFixed(3);
      canvas.dataset.atmosphereUsageActiveSessions = String(usageActivity.activeSessionCount);
      canvas.dataset.atmosphereActiveParticleCount = String(usageModulation.activeParticleCount);
      advanceAtmosphereSceneInPlace(
        scene,
        elapsedSeconds,
        usageModulation.speed,
        usageModulation.activeParticleCount,
      );
      const matrixColorFrame =
        kind === "matrix"
          ? resolveMatrixAtmosphereColorFrame(
              matrixColorMode,
              configuredColor,
              resolvedTheme === "dark",
              timestamp,
            )
          : undefined;
      drawAtmosphereScene(
        context,
        scene,
        matrixColorFrame?.color ??
          resolveAtmosphereColor(kind, configuredColor, resolvedTheme === "dark"),
        opacity,
        matrixColorFrame,
        usageModulation.activeParticleCount,
      );
    };

    const drawFrame = (timestamp: number) => {
      animationFrame = null;
      renderScene(timestamp, true);
      animationFrame = window.requestAnimationFrame(drawFrame);
    };

    const syncAnimation = () => {
      const canAnimate = shouldAnimateAtmosphere({
        enabled,
        reducedMotion: reducedMotion.matches,
        documentVisible: document.visibilityState === "visible",
        windowFocused: document.hasFocus(),
        continueBackgroundAnimations,
      });
      if (!canAnimate) {
        cancelAnimation();
        if (scene) context.clearRect(0, 0, scene.width, scene.height);
        return;
      }
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(drawFrame);
      }
    };

    const handleResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        resize();
        syncAnimation();
      });
    };

    resize();
    syncAnimation();
    document.addEventListener("visibilitychange", syncAnimation);
    window.addEventListener("focus", syncAnimation);
    window.addEventListener("blur", syncAnimation);
    window.addEventListener("resize", handleResize);
    reducedMotion.addEventListener("change", syncAnimation);

    return () => {
      cancelAnimation();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      clearCanvasBitmap();
      document.removeEventListener("visibilitychange", syncAnimation);
      window.removeEventListener("focus", syncAnimation);
      window.removeEventListener("blur", syncAnimation);
      window.removeEventListener("resize", handleResize);
      reducedMotion.removeEventListener("change", syncAnimation);
    };
  }, [
    atmosphereAvailable,
    configuredColor,
    continueBackgroundAnimations,
    density,
    enabled,
    japaneseRatio,
    kind,
    matrixColorMode,
    opacity,
    resolvedTheme,
    speed,
    usageReactive,
  ]);

  if (!enabled || !atmosphereAvailable) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-40 h-full w-full overflow-hidden"
      data-testid="window-atmosphere"
    />
  );
}
