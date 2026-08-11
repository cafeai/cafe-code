import { MATERIALS, qualityLimits } from "./config.js";
import { tessellationBoundary } from "./geometry.js";

const TAU = Math.PI * 2;
const ROMAN_GLYPHS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%&*+-=<>[]{}";
const JAPANESE_GLYPHS = "ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲン開発設計検証構築学習推論検索接続配信";
const ATLAS_GLYPHS = Array.from(new Set(Array.from(`${ROMAN_GLYPHS}${JAPANESE_GLYPHS}?`)));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / Math.max(0.00001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

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

function hslToRgb(hue, saturation = 0.88, lightness = 0.62) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const channel = (n) => {
    const k = (n + h * 12) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function hexColor(value) {
  const number = Number.parseInt(String(value).slice(1), 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}

function cssColor(color, alpha) {
  return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${clamp(alpha, 0, 1)})`;
}

function automaticColor(settings) {
  if (!settings.fallingAutoColor) return hexColor(settings.fallingColor);
  if (settings.fallingSourceProfile === "jobsearch") {
    return hexColor(settings.fallingEffectKind === "matrix" ? "#79f29a" : settings.fallingEffectKind === "rain" ? "#70c5ff" : "#eef8ff");
  }
  return hexColor(settings.fallingEffectKind === "matrix" ? "#4ade80" : settings.fallingEffectKind === "rain" ? "#38bdf8" : "#f8fafc");
}

function streamColor(settings, time, index) {
  if (settings.fallingEffectKind !== "matrix" || settings.fallingColorMode === "fixed") return automaticColor(settings);
  const period = settings.fallingSourceProfile === "jobsearch" ? 10 : 18;
  const phase = settings.fallingColorMode === "rainbow-extra" ? index * 47 : 0;
  return hslToRgb((time / period) * 360 * settings.fallingColorCycleSpeed + phase);
}

function particleCount(kind, width, height, settings) {
  if (settings.fallingSourceProfile === "jobsearch" && kind !== "rain") {
    const spacing = (kind === "matrix" ? 18 * Math.max(1, settings.fallingScale * 0.75) : 22) / settings.fallingDensity;
    return Math.min(kind === "matrix" ? 640 : 320, Math.max(12, Math.ceil(width / spacing)));
  }
  const base = kind === "matrix" ? Math.ceil(width / 24) : Math.ceil(width * height / (kind === "rain" ? 10000 : 14000));
  const minimum = kind === "matrix" ? 12 : 24;
  const maximum = kind === "matrix" ? 640 : kind === "rain" ? 440 : 320;
  return Math.min(maximum, Math.max(minimum, Math.ceil(base * settings.fallingDensity)));
}

function createFallingScene(width, height, settings) {
  const random = mulberry32((settings.seed ^ 0x46414c4c) >>> 0);
  const kind = settings.fallingEffectKind;
  const count = particleCount(kind, width, height, settings);
  const particles = Array.from({ length: count }, (_, index) => {
    if (kind === "rain") return {
      x: random() * width, y: random() * height, velocityX: -36 + random() * 18 + settings.fallingWind * 34,
      velocityY: 360 + random() * 260, size: (10 + random() * 16) * settings.fallingScale,
      phase: random() * TAU, life: random(), index,
    };
    if (kind === "snow") return {
      x: random() * width, y: random() * height, velocityX: -9 + random() * 18 + settings.fallingWind * 18,
      velocityY: (settings.fallingSourceProfile === "jobsearch" ? 25 + random() * 48 : 18 + random() * 34),
      size: (1.5 + random() * 3) * settings.fallingScale, phase: random() * TAU, life: random(), index,
    };
    const japanese = random() < settings.fallingJapaneseRatio;
    const glyphs = japanese ? JAPANESE_GLYPHS : ROMAN_GLYPHS;
    const stratifiedX = count > 0 ? ((index + 0.5) / count) * width : 0;
    return {
      x: settings.fallingSourceProfile === "jobsearch" ? (index + 0.5) / count * width : stratifiedX,
      y: random() * height, velocityX: 0,
      velocityY: settings.fallingSourceProfile === "jobsearch" ? 80 + random() * 150 : 55 + random() * 85,
      size: (12 + Math.round(random() * 5)) * settings.fallingScale, phase: random() * TAU,
      life: random(), glyphs, glyphOffset: Math.floor(random() * glyphs.length), index,
    };
  });
  return { kind, width, height, particles, time: 0, primitives: [], primitivePool: [] };
}

function project(scene, particle, x, y, settings) {
  const mode = settings.fallingMotion;
  const depth = clamp(y / Math.max(1, scene.height), 0, 1);
  if (mode === "flat") return { x, y, scale: 1, alpha: 1 };
  if (mode === "tunnel") {
    const angle = x / Math.max(1, scene.width) * TAU - Math.PI / 2 + Math.sin(particle.phase) * 0.08;
    const radius = Math.max(scene.width, scene.height) * 0.74 * depth * depth;
    return { x: scene.width / 2 + Math.cos(angle) * radius, y: scene.height / 2 + Math.sin(angle) * radius, scale: 0.4 + depth * 0.95, alpha: 1 };
  }
  const walk = mode === "walk-forward" || mode === "walk-reverse";
  const geometryDepth = walk ? particle.life : depth;
  const projectedDepth = mode === "reverse" || mode === "walk-reverse" ? 1 - geometryDepth : geometryDepth;
  const perspectiveScale = 0.58 + projectedDepth * 0.72;
  const projectedX = scene.width / 2 + (x - scene.width / 2) * perspectiveScale;
  const edgeDistance = Math.min(x, scene.width - x) / Math.max(1, scene.width * 0.12);
  const edgeBlend = 1 - smoothstep(0, 1, edgeDistance);
  const safeX = projectedX * (1 - edgeBlend) + x * edgeBlend;
  if (walk) {
    const targetSize = 1 + projectedDepth * 71;
    const fade = 1 - smoothstep(0.72, 1, particle.life);
    return { x: safeX, y, scale: targetSize / Math.max(1, particle.size), alpha: fade };
  }
  return { x: safeX, y, scale: 0.72 + projectedDepth * 0.55, alpha: 1 };
}

function advanceFallingScene(scene, delta, settings) {
  const elapsed = clamp(Number(delta) || 0, 0, 0.1);
  scene.time += elapsed;
  for (const particle of scene.particles) {
    if (settings.fallingMotion === "walk-forward" || settings.fallingMotion === "walk-reverse") {
      particle.life += elapsed * 0.36 * settings.fallingSpeed;
      if (particle.life >= 1) particle.life -= 1;
    }
    if (scene.kind === "snow") {
      particle.x += (particle.velocityX + Math.sin(scene.time * 1.4 + particle.phase) * 8) * elapsed * settings.fallingSpeed;
    } else if (scene.kind === "rain") {
      particle.x += particle.velocityX * elapsed * settings.fallingSpeed;
    }
    particle.y += particle.velocityY * elapsed * settings.fallingSpeed;
    const margin = scene.kind === "rain" ? particle.size * 2 : 24;
    if (particle.y > scene.height + margin) {
      particle.y = -margin;
      particle.x = ((particle.x % scene.width) + scene.width) % scene.width;
      if (scene.kind === "matrix") particle.glyphOffset = (particle.glyphOffset + 11) % particle.glyphs.length;
    }
    if (particle.x < -margin) particle.x = scene.width + margin;
    if (particle.x > scene.width + margin) particle.x = -margin;
  }
}

function collectPrimitives(scene, settings) {
  const output = scene.primitives;
  const pool = scene.primitivePool;
  let count = 0;
  const next = (kind) => {
    const primitive = pool[count] || (pool[count] = {});
    primitive.kind = kind;
    count += 1;
    return primitive;
  };
  if (scene.kind === "snow") {
    for (const particle of scene.particles) {
      const point = project(scene, particle, particle.x, particle.y, settings);
      const primitive = next("snow");
      primitive.x = point.x; primitive.y = point.y; primitive.size = particle.size * point.scale;
      primitive.alpha = settings.fallingOpacity * point.alpha; primitive.color = automaticColor(settings);
    }
  } else if (scene.kind === "rain") {
    for (const particle of scene.particles) {
      const from = project(scene, particle, particle.x, particle.y, settings);
      const to = project(scene, particle, particle.x + particle.velocityX * 0.025, particle.y + particle.size, settings);
      const primitive = next("rain");
      primitive.x = from.x; primitive.y = from.y; primitive.x2 = to.x; primitive.y2 = to.y;
      primitive.size = Math.max(0.75, particle.size / 12 * (from.scale + to.scale) * 0.5);
      primitive.alpha = settings.fallingOpacity * from.alpha; primitive.color = automaticColor(settings);
    }
  } else {
    for (const particle of scene.particles) {
      const trailCount = settings.fallingSourceProfile === "jobsearch" ? settings.fallingTrail : 8;
      const baseColor = streamColor(settings, scene.time, particle.index);
      for (let trail = trailCount - 1; trail >= 0; trail -= 1) {
        const spacing = settings.fallingSourceProfile === "jobsearch" ? Math.max(10, particle.size * 1.05) : particle.size;
        const sourceY = particle.y - trail * spacing;
        const point = project(scene, particle, particle.x, sourceY, settings);
        let x = point.x;
        if (settings.fallingSourceProfile === "jobsearch") {
          const fan = particle.x < scene.width / 2 ? 1 : -1;
          x += fan * Math.tan(18 * Math.PI / 180) * trail * spacing - settings.fallingWind * trail * spacing * 0.035;
        }
        const glyphIndex = (particle.glyphOffset + trail * 7 + Math.floor(Math.max(0, particle.y) / Math.max(1, particle.size))) % particle.glyphs.length;
        const tailAlpha = settings.fallingSourceProfile === "jobsearch"
          ? ((trailCount - trail) / trailCount) ** 2
          : trail === 0 ? 1 : (1 - trail / 8) * 0.7;
        const primitive = next("glyph");
        primitive.glyph = particle.glyphs[glyphIndex] || "0"; primitive.x = x; primitive.y = point.y;
        primitive.size = Math.max(1, particle.size * point.scale * (settings.fallingMatrixBaseFontSize / 14));
        primitive.alpha = settings.fallingOpacity * point.alpha * tailAlpha; primitive.color = baseColor;
      }
    }
  }
  output.length = count;
  for (let index = 0; index < count; index += 1) output[index] = pool[index];
  return output;
}

function drawPrimitives(context, primitives, reflection = false, height = 0, intensity = 1) {
  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineCap = "round";
  for (const primitive of primitives) {
    const y = reflection ? height - primitive.y : primitive.y;
    const alpha = primitive.alpha * intensity;
    context.fillStyle = cssColor(primitive.color, alpha);
    context.strokeStyle = cssColor(primitive.color, alpha);
    if (primitive.kind === "glyph") {
      context.font = `${Math.max(1, primitive.size)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      context.fillText(primitive.glyph, primitive.x, y, 144);
    } else if (primitive.kind === "rain") {
      context.lineWidth = primitive.size;
      context.beginPath();
      context.moveTo(primitive.x, y);
      context.lineTo(primitive.x2, reflection ? height - primitive.y2 : primitive.y2);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(primitive.x, y, primitive.size, 0, TAU);
      context.fill();
    }
  }
  context.restore();
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function createMatrixGpuRenderer(canvas, onStatus, { masked = false } = {}) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: false, stencil: false,
    failIfMajorPerformanceCaveat: true, powerPreference: "high-performance", premultipliedAlpha: true,
    preserveDrawingBuffer: false, desynchronized: false });
  if (!gl || gl.getParameter(gl.MAX_TEXTURE_SIZE) < 256 || gl.getParameter(gl.MAX_VERTEX_ATTRIBS) < 4) {
    return { available: false, reason: "webgl2-unavailable", resize() {}, render() { return false; }, clear() {}, dispose() {} };
  }
  let lost = false;
  let disposed = false;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let program;
  let vao;
  let quadBuffer;
  let instanceBuffer;
  let texture;
  let maskTexture;
  let glyphMap;
  let uniforms;
  let scratch = new Float32Array(12 * 1024);
  let instanceCapacityBytes = scratch.byteLength;
  let uploadedMaskSignature = "";
  let renderedFrames = 0;
  let lastError = gl.NO_ERROR;
  const vertexSource = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 aCorner;
    layout(location=1) in vec4 aRect;
    layout(location=2) in vec4 aUv;
    layout(location=3) in vec4 aColor;
    uniform vec2 uResolution;
    out vec2 vUv; out vec2 vMaskUv; out vec4 vColor;
    void main(){ vec2 p=aRect.xy+aCorner*aRect.zw; gl_Position=vec4(p.x/uResolution.x*2.-1.,1.-p.y/uResolution.y*2.,0.,1.); vUv=mix(aUv.xy,aUv.zw,aCorner); vMaskUv=p/uResolution; vColor=aColor; }`;
  const fragmentSource = `#version 300 es
    precision highp float; in vec2 vUv; in vec2 vMaskUv; in vec4 vColor;
    uniform sampler2D uAtlas,uMask; uniform float uRoughness; uniform bool uUseMask; out vec4 outColor;
    void main(){
      vec2 texel=1./vec2(textureSize(uAtlas,0));float spread=uRoughness*2.8;float coverage=texture(uAtlas,vUv).a;
      if(uRoughness>.001){coverage*=.32;
        coverage+=(texture(uAtlas,vUv+vec2(texel.x*spread,0.)).a+texture(uAtlas,vUv-vec2(texel.x*spread,0.)).a+texture(uAtlas,vUv+vec2(0.,texel.y*spread)).a+texture(uAtlas,vUv-vec2(0.,texel.y*spread)).a)*.12;
        coverage+=(texture(uAtlas,vUv+texel*spread).a+texture(uAtlas,vUv-texel*spread).a+texture(uAtlas,vUv+vec2(texel.x,-texel.y)*spread).a+texture(uAtlas,vUv+vec2(-texel.x,texel.y)*spread).a)*.05;}
      if(uUseMask)coverage*=texture(uMask,vMaskUv).a;
      outColor=vec4(vColor.rgb,vColor.a*coverage);
    }`;

  function initialize() {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    uniforms = Object.fromEntries(["uResolution", "uRoughness", "uUseMask", "uAtlas", "uMask"].map((name) => [name, gl.getUniformLocation(program, name)]));
    vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    quadBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    instanceBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    instanceCapacityBytes = scratch.byteLength; gl.bufferData(gl.ARRAY_BUFFER, instanceCapacityBytes, gl.DYNAMIC_DRAW);
    for (let index = 0; index < 3; index += 1) {
      const location = 1 + index; gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 48, index * 16); gl.vertexAttribDivisor(location, 1);
    }
    const atlasCanvas = document.createElement("canvas"); atlasCanvas.width = 1024; atlasCanvas.height = 1024;
    const context = atlasCanvas.getContext("2d"); context.clearRect(0, 0, 1024, 1024);
    context.fillStyle = "#fff"; context.textAlign = "center"; context.textBaseline = "middle";
    context.font = "48px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    const cell = 56; const columns = Math.floor(1024 / cell); glyphMap = new Map();
    ATLAS_GLYPHS.slice(0, columns * columns).forEach((glyph, index) => {
      const column = index % columns; const row = Math.floor(index / columns);
      context.fillText(glyph, column * cell + cell / 2, row * cell + cell / 2);
      glyphMap.set(glyph, [(column * cell) / 1024, (row * cell) / 1024, ((column + 1) * cell) / 1024, ((row + 1) * cell) / 1024]);
    });
    texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    maskTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.useProgram(program); gl.uniform1i(uniforms.uAtlas, 0); gl.uniform1i(uniforms.uMask, 1); uploadedMaskSignature = "";
    gl.bindVertexArray(null);
  }

  try { initialize(); } catch { return { available: false, reason: "gpu-initialization-failed", resize() {}, render() { return false; }, clear() {}, dispose() {} }; }
  const onLost = (event) => { event.preventDefault(); lost = true; onStatus("context-lost"); };
  const onRestored = () => { try { initialize(); lost = false; onStatus("restored"); } catch { onStatus("restore-failed"); } };
  canvas.addEventListener("webglcontextlost", onLost); canvas.addEventListener("webglcontextrestored", onRestored);
  function resize(nextWidth, nextHeight, nextDpr) {
    width = Math.max(1, nextWidth); height = Math.max(1, nextHeight); dpr = nextDpr;
    canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; gl.viewport(0, 0, canvas.width, canvas.height); uploadedMaskSignature = "";
  }
  function clear() { if (!lost) { gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); } }
  function render(primitives, options = {}) {
    if (lost || disposed) return false;
    const maximumInstances = 40960;
    let glyphCount = 0;
    for (const primitive of primitives) if (primitive.kind === "glyph" && glyphCount < maximumInstances) glyphCount += 1;
    const required = glyphCount * 12;
    if (scratch.length < required) scratch = new Float32Array(Math.min(maximumInstances * 12, 2 ** Math.ceil(Math.log2(required))));
    let offset = 0;
    for (const glyph of primitives) {
      if (glyph.kind !== "glyph" || offset >= required) continue;
      const uv = glyphMap.get(glyph.glyph) || glyphMap.get("?");
      const size = glyph.size * 1.35; const widthPx = glyph.size;
      const centerY = options.reflection ? height - glyph.y : glyph.y;
      scratch[offset] = glyph.x - widthPx / 2; scratch[offset + 1] = centerY - size / 2;
      scratch[offset + 2] = widthPx; scratch[offset + 3] = size;
      scratch[offset + 4] = uv[0]; scratch[offset + 5] = uv[1]; scratch[offset + 6] = uv[2]; scratch[offset + 7] = uv[3];
      scratch[offset + 8] = glyph.color[0]; scratch[offset + 9] = glyph.color[1]; scratch[offset + 10] = glyph.color[2];
      scratch[offset + 11] = glyph.alpha * (options.intensity ?? 1);
      offset += 12;
    }
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!glyphCount) return true;
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program); gl.uniform2f(uniforms.uResolution, width, height);
    gl.uniform1f(uniforms.uRoughness, options.roughness ?? 0);
    gl.uniform1i(uniforms.uUseMask, masked && options.maskCanvas ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    if (masked && options.maskCanvas) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTexture);
      if (uploadedMaskSignature !== options.maskSignature) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, options.maskCanvas);
        uploadedMaskSignature = options.maskSignature;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    if (instanceCapacityBytes < offset * 4) { instanceCapacityBytes = scratch.byteLength; gl.bufferData(gl.ARRAY_BUFFER, instanceCapacityBytes, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, scratch.subarray(0, offset));
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, glyphCount);
    gl.bindVertexArray(null);
    renderedFrames += 1;
    if (renderedFrames === 1 || renderedFrames % 120 === 0) lastError = gl.getError();
    return lastError === gl.NO_ERROR;
  }
  return { available: true, reason: null, resize, render, clear, get lastError() { return lastError; }, dispose() {
    disposed = true; canvas.removeEventListener("webglcontextlost", onLost); canvas.removeEventListener("webglcontextrestored", onRestored);
    try { gl.deleteTexture(texture); gl.deleteTexture(maskTexture); gl.deleteBuffer(quadBuffer); gl.deleteBuffer(instanceBuffer); gl.deleteVertexArray(vao); gl.deleteProgram(program); } catch {}
  } };
}

export function createFallingLayer(canvas, gpuCanvas, reflectionCanvas, reflectionGpuCanvas) {
  const context = canvas.getContext("2d", { alpha: true });
  const reflectionContext = reflectionCanvas.getContext("2d", { alpha: true });
  const frameCanvas = document.createElement("canvas");
  const frameContext = frameCanvas.getContext("2d", { alpha: true });
  const reflectionFrame = document.createElement("canvas");
  const reflectionFrameContext = reflectionFrame.getContext("2d", { alpha: true });
  const maskCanvas = document.createElement("canvas");
  const maskContext = maskCanvas.getContext("2d", { alpha: true });
  let scene = null;
  let signature = "";
  let width = 1;
  let height = 1;
  let dpr = 1;
  let maskSignature = "";
  let disposed = false;
  let gpuState = "available";
  let reflectionGpuState = "available";
  let canvasDirty = false;
  let gpuDirty = false;
  let reflectionCanvasDirty = false;
  let reflectionGpuDirty = false;
  const gpu = createMatrixGpuRenderer(gpuCanvas, (state) => { gpuState = state; });
  const reflectionGpu = createMatrixGpuRenderer(reflectionGpuCanvas, (state) => { reflectionGpuState = state; }, { masked: true });

  function resize(nextWidth, nextHeight, requestedDpr, settings) {
    width = Math.max(1, nextWidth); height = Math.max(1, nextHeight);
    const limits = qualityLimits(settings.quality);
    dpr = Math.max(0.5, Math.min(requestedDpr, limits.dpr, Math.sqrt(limits.backingPixels / Math.max(1, width * height))));
    for (const target of [canvas, reflectionCanvas, frameCanvas, reflectionFrame, maskCanvas]) {
      target.width = Math.max(1, Math.round(width * dpr)); target.height = Math.max(1, Math.round(height * dpr));
      if (target.style) { target.style.width = `${width}px`; target.style.height = `${height}px`; }
    }
    gpu.resize(width, height, dpr); reflectionGpu.resize(width, height, dpr);
    signature = ""; maskSignature = ""; canvasDirty = false; gpuDirty = false; reflectionCanvasDirty = false; reflectionGpuDirty = false;
  }

  function clearSurface(targetContext, targetCanvas) {
    targetContext.setTransform(1,0,0,1,0,0); targetContext.clearRect(0,0,targetCanvas.width,targetCanvas.height);
  }

  function rebuildMask(tileFrame, settings) {
    const nextSignature = `${tileFrame.grid.mode}:${tileFrame.grid.radius}:${tileFrame.grid.tiles.length}:${settings.gapWidth}:${width}:${height}:${dpr}`;
    if (nextSignature === maskSignature) return;
    maskSignature = nextSignature; clearSurface(maskContext, maskCanvas); maskContext.setTransform(dpr,0,0,dpr,0,0);
    maskContext.fillStyle = "#fff"; maskContext.beginPath();
    const scale = Math.max(0, 1 - settings.gapWidth);
    for (const tile of tileFrame.grid.tiles) {
      const points = tessellationBoundary(tileFrame.grid.mode, tile.x, tile.y, tileFrame.grid.radius).map(([x, y]) => [
        tile.x + (x - tile.x) * scale,
        tile.y + (y - tile.y) * scale,
      ]);
      maskContext.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) maskContext.lineTo(points[index][0], points[index][1]);
      maskContext.closePath();
    }
    maskContext.fill();
  }

  function render(delta, tileFrame, settings) {
    if (disposed) return { status: "disposed", renderer: "none", primitives: 0 };
    if (!settings.fallingEffectsEnabled) {
      if (canvasDirty) { clearSurface(context, canvas); canvasDirty = false; }
      if (gpuDirty) { gpu.clear(); gpuDirty = false; }
      if (reflectionCanvasDirty) { clearSurface(reflectionContext, reflectionCanvas); reflectionCanvasDirty = false; }
      if (reflectionGpuDirty) { reflectionGpu.clear(); reflectionGpuDirty = false; }
      canvas.hidden = true; gpuCanvas.hidden = true; reflectionCanvas.hidden = true; reflectionGpuCanvas.hidden = true;
      return { status: "disabled", renderer: "none", primitives: 0 };
    }
    const nextSignature = `${settings.fallingSourceProfile}:${settings.fallingEffectKind}:${settings.fallingDensity}:${settings.fallingScale}:${settings.fallingJapaneseRatio}:${settings.fallingMotion}:${settings.seed}:${width}:${height}`;
    if (!scene || signature !== nextSignature) { scene = createFallingScene(width, height, settings); signature = nextSignature; }
    advanceFallingScene(scene, delta, settings);
    const primitives = collectPrimitives(scene, settings);
    const useGpu = settings.renderer !== "canvas" && settings.fallingEffectKind === "matrix" && gpu.available && gpuState !== "context-lost" && gpu.render(primitives);
    if (useGpu) {
      gpuCanvas.hidden = false; canvas.hidden = true; gpuDirty = true;
      if (canvasDirty) { clearSurface(context, canvas); canvasDirty = false; }
    } else {
      gpuCanvas.hidden = true; canvas.hidden = false;
      if (gpuDirty) { gpu.clear(); gpuDirty = false; }
      clearSurface(frameContext, frameCanvas); frameContext.setTransform(dpr,0,0,dpr,0,0);
      drawPrimitives(frameContext, primitives);
      clearSurface(context, canvas); context.drawImage(frameCanvas, 0, 0);
      canvasDirty = true;
    }
    let reflectionRenderer = "none";
    if (settings.fallingReflectionEnabled && settings.reflectionIntensity > 0) {
      rebuildMask(tileFrame, settings);
      const material = MATERIALS[settings.material];
      const reflectionIntensity = settings.reflectionIntensity * (1 - material.roughness * 0.48);
      const useGpuReflection = settings.renderer !== "canvas" && settings.fallingEffectKind === "matrix" && reflectionGpu.available && reflectionGpuState !== "context-lost" && reflectionGpu.render(primitives, {
        reflection: true, intensity: reflectionIntensity, roughness: material.roughness,
        maskCanvas, maskSignature,
      });
      if (useGpuReflection) {
        reflectionGpuCanvas.hidden = false; reflectionCanvas.hidden = true; reflectionGpuDirty = true; reflectionRenderer = "gpu-matrix-reflection";
        if (reflectionCanvasDirty) { clearSurface(reflectionContext, reflectionCanvas); reflectionCanvasDirty = false; }
      } else {
        reflectionGpuCanvas.hidden = true; reflectionCanvas.hidden = false;
        if (reflectionGpuDirty) { reflectionGpu.clear(); reflectionGpuDirty = false; }
        clearSurface(reflectionFrameContext, reflectionFrame); reflectionFrameContext.setTransform(dpr,0,0,dpr,0,0);
        reflectionFrameContext.filter = `blur(${(material.roughness * 3.5).toFixed(2)}px)`;
        reflectionFrameContext.globalCompositeOperation = settings.material === "glass" ? "screen" : "source-over";
        drawPrimitives(reflectionFrameContext, primitives, true, height, reflectionIntensity);
        reflectionFrameContext.setTransform(1,0,0,1,0,0); reflectionFrameContext.filter = "none";
        reflectionFrameContext.globalCompositeOperation = "destination-in"; reflectionFrameContext.drawImage(maskCanvas, 0, 0);
        clearSurface(reflectionContext, reflectionCanvas); reflectionContext.drawImage(reflectionFrame, 0, 0);
        reflectionCanvasDirty = true; reflectionRenderer = "canvas2d-reflection";
      }
    } else {
      reflectionCanvas.hidden = true; reflectionGpuCanvas.hidden = true;
      if (reflectionCanvasDirty) { clearSurface(reflectionContext, reflectionCanvas); reflectionCanvasDirty = false; }
      if (reflectionGpuDirty) { reflectionGpu.clear(); reflectionGpuDirty = false; }
    }
    return { status: "rendered", renderer: useGpu ? "gpu-matrix-atlas" : "canvas2d-atomic", reflectionRenderer, primitives: primitives.length, profile: settings.fallingSourceProfile };
  }

  return { available: Boolean(context && reflectionContext), resize, render, dispose() { disposed = true; gpu.dispose(); reflectionGpu.dispose(); } };
}

export const __fallingTest = { particleCount, createFallingScene, advanceFallingScene, collectPrimitives };
