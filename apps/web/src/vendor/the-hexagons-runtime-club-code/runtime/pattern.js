const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

function hash32(a, b, seed) {
  let value = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export function tilePatternOffset(tile, scene, settings) {
  if (settings.colorPattern === "facet") return 0;
  const scale = Math.max(1, Math.round(settings.patternScale));
  const column = Math.floor(tile.column / scale);
  const row = Math.floor(tile.row / scale);
  const phase = Math.round(settings.patternPhase);
  // A rhombille paver field gets its cube-and-star illusion from a fixed color
  // assignment by facet orientation. Rotating neighboring tiles destroys that
  // continuous pattern, so phase is the only offset in backyard mode.
  if (settings.colorPattern === "backyard-star") return positiveModulo(phase, 3);
  if (settings.colorPattern === "rotating-triplets") return positiveModulo(column + row * 2 + phase, 3);
  if (settings.colorPattern === "checker") return positiveModulo(column + row + phase, 3);
  if (settings.colorPattern === "rings") {
    const distance = Math.hypot(tile.x - scene.viewport.width / 2, tile.y - scene.viewport.height / 2);
    return positiveModulo(Math.floor(distance / Math.max(1, scene.grid.radius * scale * 1.8)) + phase, 3);
  }
  return hash32(column, row, settings.seed ^ Math.imul(phase + 1, 0x51ed270b)) % 3;
}

export function facetPaletteIndex(facet, patternOffset, settings) {
  const direction = settings.patternMirror ? -1 : 1;
  return positiveModulo(direction * Math.round(facet) + Math.round(settings.patternRotation) + Math.round(patternOffset), 3);
}
