import { buildTessellationGrid, tessellationBoundary } from "./geometry.js";
import { qualityLimits } from "./config.js";
import { tilePatternOffset } from "./pattern.js";

const TAU = Math.PI * 2;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let output = value;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGapParticles(grid, settings, maximumParticles) {
  const random = mulberry32(settings.seed ^ 0x50415254);
  const requestedMaximum = Math.floor(Number(maximumParticles));
  const maximum = Math.min(
    settings.particleCount,
    qualityLimits(settings.quality).meshParticles,
    Number.isFinite(requestedMaximum) ? Math.max(0, requestedMaximum) : Number.POSITIVE_INFINITY,
  );
  if (maximum === 0 || grid.tiles.length === 0) return [];
  const edgeCount = grid.mode === "hexagram" ? 12 : 6;
  return Array.from({ length: maximum }, () => {
    const tileIndex = Math.floor(random() * Math.max(1, grid.tiles.length));
    const edge = Math.floor(random() * edgeCount);
    const tile = grid.tiles[tileIndex];
    const vertices = tessellationBoundary(grid.mode, tile.x, tile.y, grid.radius);
    const start = vertices[edge % vertices.length];
    const end = vertices[(edge + 1) % vertices.length];
    return {
      tileIndex,
      edge,
      startX: start[0],
      startY: start[1],
      endX: end[0],
      endY: end[1],
      progress: random(),
      speed: settings.particleSpeed * (1 - settings.particleSpeedVariation + random() * settings.particleSpeedVariation * 2),
      size: 0.7 + random() * 2.1,
      phase: random() * TAU,
    };
  });
}

export function createScene(viewport, display, settings, maximumTiles) {
  const grid = buildTessellationGrid(viewport, display, settings, maximumTiles);
  const gapParticles = buildGapParticles(grid, settings, maximumTiles);
  return {
    viewport: { ...viewport },
    display: { ...display },
    grid,
    time: 0,
    gapParticles,
    tileInstances: new Float32Array(grid.tiles.length * 8),
    gapInstances: new Float32Array(Math.max(1, gapParticles.length) * 4),
    gapInstanceCount: 0,
  };
}

function pistonHeight(tile, scene, settings, pointer) {
  if (settings.pistonMode === "off") return 0;
  const { width, height } = scene.viewport;
  const nx = (tile.x - width / 2) / Math.max(1, width / 2);
  const ny = (tile.y - height / 2) / Math.max(1, height / 2);
  const radial = Math.min(1.4, Math.hypot(nx, ny));
  const clock = scene.time * settings.pistonSpeed * TAU;
  if (settings.pistonMode === "pit") {
    const distance = clamp(radial / 1.05, 0, 1);
    const bowl = distance * distance * (3 - 2 * distance);
    const breathing = 1 + Math.sin(clock * 0.22) * 0.04;
    let height = (bowl * 2.15 - 1) * settings.pitDepth * breathing;
    if (settings.pointerAttractionEnabled && pointer?.active) {
      const pointerDistance = Math.hypot(tile.x - pointer.x, tile.y - pointer.y);
      height += Math.exp(-pointerDistance / Math.max(80, scene.grid.radius * 9)) * settings.pitDepth * 0.12;
    }
    return clamp(height, -12, 12);
  }
  let wave = settings.pistonMode === "radial"
    ? Math.cos(radial * Math.PI * 2.4 - clock + tile.phase * 0.12)
    : Math.sin(nx * 5.2 + ny * 3.1 - clock + tile.phase * 0.18);
  wave = wave * 0.44 + (radial - 0.48) * 0.9;
  if (settings.pointerAttractionEnabled && pointer?.active) {
    const distance = Math.hypot(tile.x - pointer.x, tile.y - pointer.y);
    wave += Math.exp(-distance / Math.max(80, scene.grid.radius * 9)) * 0.9;
  }
  return clamp(wave * settings.pistonAmplitude, -1.25, 1.5);
}

function tilePulse(tile, scene, settings) {
  if (!settings.emberPulse) return 0;
  if (settings.emberPattern !== "organic") return settings.emberIntensity * (0.78 + Math.sin(scene.time * 0.8) * 0.22);
  const carrier = Math.sin(scene.time * 0.78 + tile.phase * 3.7);
  return Math.pow(Math.max(0, carrier - 0.72) / 0.28, 2) * settings.emberIntensity;
}

function tileSeparation(tile, scene, settings) {
  if (settings.separationAmount <= 0 || settings.separationFrequency <= 0) return 0;
  const eligible = tile.random < settings.separationFrequency;
  if (!eligible) return 0;
  if (!settings.separationCycle) return settings.separationAmount;
  const cycle = Math.sin(scene.time * 0.42 + tile.phase);
  return Math.pow(Math.max(0, cycle - 0.35) / 0.65, 2) * settings.separationAmount;
}

function writeGapInstances(scene, settings) {
  let count = 0;
  const enabled = settings.gapParticles !== "off" && scene.grid.tiles.length > 0;
  const cycleOpacity = settings.gapParticles === "cycling" ? 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(scene.time * 0.31), 2) : 1;
  if (!enabled || cycleOpacity < 0.02) {
    scene.gapInstanceCount = 0;
    return;
  }
  for (const particle of scene.gapParticles) {
    const t = (particle.progress + scene.time * particle.speed * 0.18) % 1;
    const offset = count * 4;
    scene.gapInstances[offset] = particle.startX + (particle.endX - particle.startX) * t;
    scene.gapInstances[offset + 1] = particle.startY + (particle.endY - particle.startY) * t;
    scene.gapInstances[offset + 2] = particle.size;
    scene.gapInstances[offset + 3] = cycleOpacity * (0.45 + 0.55 * Math.sin(particle.phase + scene.time * 2.1) ** 2);
    count += 1;
  }
  scene.gapInstanceCount = count;
}

export function advanceScene(scene, elapsedSeconds, settings, pointer) {
  const delta = clamp(Number(elapsedSeconds) || 0, 0, 0.1);
  scene.time += delta;
  const radius = scene.grid.radius;
  for (let index = 0; index < scene.grid.tiles.length; index += 1) {
    const tile = scene.grid.tiles[index];
    const offset = index * 8;
    scene.tileInstances[offset] = tile.x;
    scene.tileInstances[offset + 1] = tile.y;
    scene.tileInstances[offset + 2] = radius;
    scene.tileInstances[offset + 3] = pistonHeight(tile, scene, settings, pointer);
    scene.tileInstances[offset + 4] = tile.phase;
    scene.tileInstances[offset + 5] = tilePulse(tile, scene, settings);
    scene.tileInstances[offset + 6] = tileSeparation(tile, scene, settings);
    scene.tileInstances[offset + 7] = tilePatternOffset(tile, scene, settings);
  }
  writeGapInstances(scene, settings);
  return scene;
}

export function shouldAnimate({ enabled, reducedMotion, documentVisible, windowFocused, continueBackgroundAnimations }) {
  if (!enabled || reducedMotion) return false;
  return continueBackgroundAnimations || (documentVisible && windowFocused);
}
