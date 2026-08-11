import { RATIO_PRESETS, qualityLimits } from "./config.js";

export const SQRT3 = Math.sqrt(3);

export function cssPixelsPerInch(viewport, display, settings) {
  if (settings.manualCssPixelsPerInch > 0) return settings.manualCssPixelsPerInch;
  const width = Math.max(1, Number(display?.width) || viewport.width);
  const height = Math.max(1, Number(display?.height) || viewport.height);
  return Math.hypot(width, height) / settings.displayDiagonalInches;
}

export function targetTileRadius(viewport, display, settings) {
  const ratio = RATIO_PRESETS[settings.ratioPreset]?.factor ?? 1;
  return Math.max(4, (settings.tripletLongSpanInches * cssPixelsPerInch(viewport, display, settings) * ratio) / 2);
}

function snapRadiusForWholeTiles(width, targetRadius) {
  const approximateColumns = Math.max(1, Math.round((width / targetRadius - 0.5) / 1.5));
  let best = targetRadius;
  let score = Number.POSITIVE_INFINITY;
  for (let columns = Math.max(1, approximateColumns - 4); columns <= approximateColumns + 4; columns += 1) {
    const radius = width / (2 + 1.5 * Math.max(0, columns - 1));
    const candidateScore = Math.abs(Math.log(radius / targetRadius));
    if (candidateScore < score) {
      best = radius;
      score = candidateScore;
    }
  }
  return best;
}

export function resolveTileMetrics(viewport, display, settings) {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const requestedRadius = targetTileRadius(viewport, display, settings);
  const radius = settings.alignmentMode === "whole-tiles" && settings.ratioLockOnResize
    ? snapRadiusForWholeTiles(width, requestedRadius)
    : requestedRadius;
  return {
    radius,
    requestedRadius,
    apothem: (SQRT3 * radius) / 2,
    cssPixelsPerInch: cssPixelsPerInch(viewport, display, settings),
  };
}

function hash32(a, b, seed) {
  let value = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function tileMetadata(column, row, settings) {
  return {
    column,
    row,
    phase: (hash32(column, row, settings.seed) / 0xffffffff) * Math.PI * 2,
    random: hash32(row, column, settings.seed ^ 0xa5a5a5a5) / 0xffffffff,
  };
}

function centerCompleteTiles(candidates, viewport, halfWidth, halfHeight) {
  if (candidates.length === 0) return;
  const minimumX = Math.min(...candidates.map((tile) => tile.x - halfWidth));
  const maximumX = Math.max(...candidates.map((tile) => tile.x + halfWidth));
  const minimumY = Math.min(...candidates.map((tile) => tile.y - halfHeight));
  const maximumY = Math.max(...candidates.map((tile) => tile.y + halfHeight));
  const shiftX = (viewport.width - (maximumX - minimumX)) / 2 - minimumX;
  const shiftY = (viewport.height - (maximumY - minimumY)) / 2 - minimumY;
  for (const tile of candidates) {
    tile.x += shiftX;
    tile.y += shiftY;
  }
}

function withinViewport(x, y, halfWidth, halfHeight, viewport, whole) {
  const complete = x - halfWidth >= -0.001 && x + halfWidth <= viewport.width + 0.001 &&
    y - halfHeight >= -0.001 && y + halfHeight <= viewport.height + 0.001;
  return whole ? complete : x + halfWidth >= 0 && x - halfWidth <= viewport.width &&
    y + halfHeight >= 0 && y - halfHeight <= viewport.height;
}

function buildOffsetRowGrid(viewport, display, settings, mode, dimensions) {
  const initialMetrics = resolveTileMetrics(viewport, display, settings);
  const whole = settings.alignmentMode === "whole-tiles";
  const limit = qualityLimits(settings.quality).tiles;
  const collect = (radius) => {
    const { halfWidth, halfHeight, columnStep, rowStep, rowOffset } = dimensions(radius);
    const padding = whole ? 0 : 3;
    const startRow = -padding;
    const startColumn = -padding;
    const rowCount = Math.ceil(viewport.height / rowStep) + padding * 2 + 2;
    const columnCount = Math.ceil(viewport.width / columnStep) + padding * 2 + 3;
    const candidates = [];
    for (let row = startRow; row < startRow + rowCount; row += 1) {
      const offsetX = (Math.abs(row) % 2) * rowOffset;
      for (let column = startColumn; column < startColumn + columnCount; column += 1) {
        const x = halfWidth + column * columnStep + offsetX;
        const y = halfHeight + row * rowStep;
        if (withinViewport(x, y, halfWidth, halfHeight, viewport, whole)) {
          candidates.push({ ...tileMetadata(column, row, settings), x, y });
        }
      }
    }
    if (whole) centerCompleteTiles(candidates, viewport, halfWidth, halfHeight);
    return { radius, halfWidth, halfHeight, apothem: halfHeight, candidates };
  };
  let radius = initialMetrics.radius;
  let result = collect(radius);
  const limited = result.candidates.length > limit;
  for (let attempt = 0; result.candidates.length > limit && attempt < 4; attempt += 1) {
    radius *= Math.sqrt(result.candidates.length / limit) * 1.025;
    result = collect(radius);
  }
  return {
    ...initialMetrics,
    mode,
    radius: result.radius,
    apothem: result.apothem,
    halfWidth: result.halfWidth,
    halfHeight: result.halfHeight,
    tiles: result.candidates,
    limited,
  };
}

export function buildHexGrid(viewport, display, settings) {
  const initialMetrics = resolveTileMetrics(viewport, display, settings);
  const { width, height } = viewport;
  const whole = settings.alignmentMode === "whole-tiles";
  const limit = qualityLimits(settings.quality).tiles;
  const collect = (radius) => {
    const apothem = (SQRT3 * radius) / 2;
    const startColumn = whole ? 0 : -2;
    const columnCount = Math.ceil(width / (1.5 * radius)) + (whole ? 1 : 4);
    const rowCount = Math.ceil(height / (2 * apothem)) + (whole ? 1 : 4);
    const startRow = whole ? 0 : -2;
    const candidates = [];
    for (let column = startColumn; column < startColumn + columnCount; column += 1) {
      const x = radius + column * 1.5 * radius;
      const offsetY = (Math.abs(column) % 2) * apothem;
      for (let row = startRow; row < startRow + rowCount; row += 1) {
        const y = apothem + row * 2 * apothem + offsetY;
        const complete = x - radius >= -0.001 && x + radius <= width + 0.001 && y - apothem >= -0.001 && y + apothem <= height + 0.001;
        if (whole ? complete : x + radius >= 0 && x - radius <= width && y + apothem >= 0 && y - apothem <= height) {
          candidates.push({ ...tileMetadata(column, row, settings), x, y });
        }
      }
    }
    if (whole && candidates.length > 0) {
      const minimumX = Math.min(...candidates.map((tile) => tile.x - radius));
      const maximumX = Math.max(...candidates.map((tile) => tile.x + radius));
      const minimumY = Math.min(...candidates.map((tile) => tile.y - apothem));
      const maximumY = Math.max(...candidates.map((tile) => tile.y + apothem));
      const shiftX = (width - (maximumX - minimumX)) / 2 - minimumX;
      const shiftY = (height - (maximumY - minimumY)) / 2 - minimumY;
      for (const tile of candidates) {
        tile.x += shiftX;
        tile.y += shiftY;
      }
    }
    return { radius, apothem, candidates };
  };

  let radius = initialMetrics.radius;
  let result = collect(radius);
  const limited = result.candidates.length > limit;
  for (let attempt = 0; result.candidates.length > limit && attempt < 4; attempt += 1) {
    radius *= Math.sqrt(result.candidates.length / limit) * 1.025;
    result = collect(radius);
  }
  return {
    ...initialMetrics,
    mode: "rhombille",
    radius: result.radius,
    apothem: result.apothem,
    halfWidth: result.radius,
    halfHeight: result.apothem,
    tiles: result.candidates,
    limited,
  };
}

export function buildCairoGrid(viewport, display, settings) {
  return buildOffsetRowGrid(viewport, display, settings, "cairo-pentagon", (radius) => ({
    halfWidth: radius * 11 / 14,
    halfHeight: radius,
    columnStep: radius * 2,
    rowStep: radius,
    rowOffset: radius,
  }));
}

export function buildHexagramGrid(viewport, display, settings) {
  return buildOffsetRowGrid(viewport, display, settings, "hexagram", (radius) => ({
    halfWidth: radius,
    halfHeight: radius * SQRT3 / 2,
    columnStep: radius * 2,
    rowStep: radius * SQRT3,
    rowOffset: radius,
  }));
}

export function buildTessellationGrid(viewport, display, settings) {
  if (settings.tessellationMode === "cairo-pentagon") return buildCairoGrid(viewport, display, settings);
  if (settings.tessellationMode === "hexagram") return buildHexagramGrid(viewport, display, settings);
  return buildHexGrid(viewport, display, settings);
}

export function hexVertices(centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return [centerX + shiftX + Math.cos(angle) * radius * scale, centerY + shiftY + Math.sin(angle) * radius * scale];
  });
}

export function threeRhombi(centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  const vertices = hexVertices(centerX, centerY, radius, scale, shiftX, shiftY);
  const center = [centerX + shiftX, centerY + shiftY];
  return [
    [center, vertices[0], vertices[1], vertices[2]],
    [center, vertices[2], vertices[3], vertices[4]],
    [center, vertices[4], vertices[5], vertices[0]],
  ];
}

const CAIRO_POINTS = Object.freeze({
  a: [-11 / 14, 0], b: [-3 / 14, 1], c: [3 / 14, 1], d: [11 / 14, 0],
  e: [3 / 14, -1], f: [-3 / 14, -1], leftTop: [-0.5, 0.5], middleTop: [0, 3 / 14],
  rightTop: [0.5, 0.5], middleBottom: [0, -3 / 14], rightBottom: [0.5, -0.5], leftBottom: [-0.5, -0.5],
});

function transformPoints(points, centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  return points.map(([x, y]) => [centerX + shiftX + x * radius * scale, centerY + shiftY + y * radius * scale]);
}

export function cairoPentagons(centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  const p = CAIRO_POINTS;
  return [
    [p.b, p.c, p.rightTop, p.middleTop, p.leftTop],
    [p.d, p.rightBottom, p.middleBottom, p.middleTop, p.rightTop],
    [p.e, p.f, p.leftBottom, p.middleBottom, p.rightBottom],
    [p.a, p.leftTop, p.middleTop, p.middleBottom, p.leftBottom],
  ].map((points) => transformPoints(points, centerX, centerY, radius, scale, shiftX, shiftY));
}

export function hexagramVertices(centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  return Array.from({ length: 12 }, (_, index) => {
    const angle = index * Math.PI / 6;
    const localRadius = radius * scale * (index % 2 === 0 ? 1 : 0.5);
    return [centerX + shiftX + Math.cos(angle) * localRadius, centerY + shiftY + Math.sin(angle) * localRadius];
  });
}

export function hexagramFacets(centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  const center = [centerX + shiftX, centerY + shiftY];
  const vertices = hexagramVertices(centerX, centerY, radius, scale, shiftX, shiftY);
  return vertices.map((vertex, index) => [center, vertex, vertices[(index + 1) % vertices.length]]);
}

export function tessellationFacets(mode, centerX, centerY, radius, scale = 1, shiftX = 0, shiftY = 0) {
  if (mode === "cairo-pentagon") return cairoPentagons(centerX, centerY, radius, scale, shiftX, shiftY);
  if (mode === "hexagram") return hexagramFacets(centerX, centerY, radius, scale, shiftX, shiftY);
  return threeRhombi(centerX, centerY, radius, scale, shiftX, shiftY);
}

export function tessellationBoundary(mode, centerX, centerY, radius) {
  if (mode === "cairo-pentagon") {
    const p = CAIRO_POINTS;
    return transformPoints([p.a, p.b, p.c, p.d, p.e, p.f], centerX, centerY, radius);
  }
  if (mode === "hexagram") return hexagramVertices(centerX, centerY, radius);
  return hexVertices(centerX, centerY, radius);
}

export function gridHasOnlyCompleteTiles(grid, viewport) {
  const epsilon = 0.01;
  const halfWidth = grid.halfWidth ?? grid.radius;
  const halfHeight = grid.halfHeight ?? grid.apothem;
  return grid.tiles.every((tile) =>
    tile.x - halfWidth >= -epsilon && tile.x + halfWidth <= viewport.width + epsilon &&
    tile.y - halfHeight >= -epsilon && tile.y + halfHeight <= viewport.height + epsilon,
  );
}
