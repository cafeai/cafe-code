import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_MONO_FONT_FAMILY,
  CHAT_SANS_FONT_FAMILY,
  GENERATED_VISUALIZATION_FONT_FAMILY_STYLE,
} from "./chatTypography.ts";
import {
  VISUALIZATION_FONT_DATA,
  VISUALIZATION_FONT_LICENSE,
  VISUALIZATION_FONT_LICENSE_SHA256,
  VISUALIZATION_FONT_PACKAGE,
  VISUALIZATION_FONT_PACKAGE_VERSION,
  VISUALIZATION_FONT_TOTAL_BASE64_BYTES,
  VISUALIZATION_FONT_TOTAL_BYTES,
} from "./visualizationFontData.ts";
import {
  decodeVisualizationFontBytes,
  GENERATED_VISUALIZATION_FONT_APPENDIX,
  loadGeneratedVisualizationFontFaces,
} from "./visualizationFonts.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const installed = (name: string) =>
  new URL(`../../../node_modules/@fontsource-variable/dm-sans/${name}`, import.meta.url);
const unavailable = "Generated visualization typography is unavailable.";
afterEach(() => vi.unstubAllGlobals());

describe("committed offline chat typography", () => {
  it("matches the exact existing package, four byte commitments and full readable OFL", () => {
    const packageJson = JSON.parse(readFileSync(installed("package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(packageJson.name).toBe(VISUALIZATION_FONT_PACKAGE);
    expect(packageJson.version).toBe(VISUALIZATION_FONT_PACKAGE_VERSION);
    expect(VISUALIZATION_FONT_PACKAGE_VERSION).toBe("5.3.0");
    expect(
      VISUALIZATION_FONT_DATA.map((face) => [face.filename, face.byteLength, face.sha256]),
    ).toEqual([
      [
        "dm-sans-latin-opsz-normal.woff2",
        62724,
        "ca72d2bcea8f4daa783dbdfa2d9b46068c3ce38168e05918fb867aa453b4f890",
      ],
      [
        "dm-sans-latin-ext-opsz-normal.woff2",
        31292,
        "5d18d31d23ada61ebee1d589b11d5da30db9e158f589d5e35221ba2b1a45de54",
      ],
      [
        "dm-sans-latin-opsz-italic.woff2",
        76248,
        "d5c53a50536536971ea27318a590dbf723a190dd2f608e7a92929a021cc0ebaa",
      ],
      [
        "dm-sans-latin-ext-opsz-italic.woff2",
        40840,
        "b72f7226650dcbc66e1e6ccdc9e53dc8c66107357eeac2d2a4ca18942c42f360",
      ],
    ]);
    for (const face of VISUALIZATION_FONT_DATA) {
      const bytes = readFileSync(installed(`files/${face.filename}`));
      expect(Buffer.from(face.base64, "base64")).toEqual(bytes);
      expect(bytes.byteLength).toBe(face.byteLength);
      expect(hash(bytes)).toBe(face.sha256);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
      expect(bytes.readUInt32BE(8)).toBe(face.byteLength);
      expect(Object.isFrozen(face)).toBe(true);
    }
    expect(Object.isFrozen(VISUALIZATION_FONT_DATA)).toBe(true);
    expect(VISUALIZATION_FONT_DATA.reduce((total, face) => total + face.byteLength, 0)).toBe(
      211104,
    );
    expect(VISUALIZATION_FONT_TOTAL_BYTES).toBe(211104);
    expect(VISUALIZATION_FONT_DATA.reduce((total, face) => total + face.base64.length, 0)).toBe(
      281476,
    );
    expect(VISUALIZATION_FONT_TOTAL_BASE64_BYTES).toBe(281476);
    expect(VISUALIZATION_FONT_LICENSE).toBe(readFileSync(installed("LICENSE"), "utf8"));
    expect(Buffer.byteLength(VISUALIZATION_FONT_LICENSE, "utf8")).toBe(4502);
    expect(hash(VISUALIZATION_FONT_LICENSE)).toBe(VISUALIZATION_FONT_LICENSE_SHA256);
    expect(VISUALIZATION_FONT_LICENSE_SHA256).toBe(
      "6fbd040a29c2037a765dfb9f2561e9965b5c95c6dcb5dce516089d63d5f17af7",
    );
    expect(VISUALIZATION_FONT_LICENSE).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("copies existing normal/italic variable descriptors and Latin/extended ranges exactly", () => {
    for (const style of ["normal", "italic"] as const) {
      const css = readFileSync(
        installed(style === "normal" ? "opsz.css" : "opsz-italic.css"),
        "utf8",
      );
      for (const face of VISUALIZATION_FONT_DATA.filter(
        (descriptor) => descriptor.style === style,
      )) {
        const declaration = css
          .match(/@font-face\s*\{[^}]+\}/g)
          ?.find((block) => block.includes(face.filename));
        expect(declaration).toBeDefined();
        expect(declaration).toContain(`font-style: ${face.style};`);
        expect(declaration).toContain(`font-weight: ${face.weight};`);
        expect(declaration).toContain(`unicode-range: ${face.unicodeRange};`);
        expect(declaration).toContain("font-family: 'DM Sans Variable';");
      }
    }
  });

  it("retains the exact chat sans/mono stacks with family-only semantic-code policy", () => {
    const css = readFileSync(new URL("../../../apps/web/src/index.css", import.meta.url), "utf8");
    const declaration = (name: string) =>
      css
        .match(new RegExp(`${name}:([^;]+);`))?.[1]
        ?.trim()
        .replace(/\s+/g, " ");
    expect(declaration("--font-sans")).toBe(CHAT_SANS_FONT_FAMILY);
    expect(declaration("--font-mono")).toBe(CHAT_MONO_FONT_FAMILY);
    expect(GENERATED_VISUALIZATION_FONT_FAMILY_STYLE).toContain(
      `body,body *{font-family:${CHAT_SANS_FONT_FAMILY}!important}`,
    );
    expect(GENERATED_VISUALIZATION_FONT_FAMILY_STYLE).toContain(
      `pre,code,kbd,samp,pre *,code *,kbd *,samp *{font-family:${CHAT_MONO_FONT_FAMILY}!important}`,
    );
    expect(GENERATED_VISUALIZATION_FONT_FAMILY_STYLE).not.toMatch(
      /font-(?:size|weight|style):|line-height:|\b(?:width|height):|url\(/,
    );
  });

  it("embeds all exact faces and complete notice only in the derived fixed portable appendix", () => {
    expect(GENERATED_VISUALIZATION_FONT_APPENDIX.match(/@font-face\{/g)).toHaveLength(4);
    expect(GENERATED_VISUALIZATION_FONT_APPENDIX).toContain(VISUALIZATION_FONT_LICENSE);
    expect(GENERATED_VISUALIZATION_FONT_APPENDIX).toContain(
      GENERATED_VISUALIZATION_FONT_FAMILY_STYLE,
    );
    for (const face of VISUALIZATION_FONT_DATA)
      expect(GENERATED_VISUALIZATION_FONT_APPENDIX).toContain(
        `src:url(data:font/woff2;base64,${face.base64})`,
      );
    expect(VISUALIZATION_FONT_LICENSE).not.toMatch(/\*\/|<\/style/i);
    expect(GENERATED_VISUALIZATION_FONT_APPENDIX).not.toContain("<script");
    // Original copyright/FAQ URLs inside the complete OFL comment are inert
    // license text, not font requests. Bind no-network to actual CSS after it.
    const fontCss = GENERATED_VISUALIZATION_FONT_APPENDIX.slice(
      GENERATED_VISUALIZATION_FONT_APPENDIX.indexOf("\n*/\n") + 4,
    );
    expect(fontCss).not.toMatch(/https?:|asset\//);
  });
});

describe("bounded binary generated-only font admission", () => {
  it("decodes and cryptographically admits all four fixed WOFF2 byte buffers", async () => {
    vi.stubGlobal("crypto", webcrypto);
    for (const face of VISUALIZATION_FONT_DATA) {
      const bytes = await decodeVisualizationFontBytes(face.base64, face);
      expect(bytes).toBeInstanceOf(ArrayBuffer);
      expect(Buffer.from(bytes)).toEqual(readFileSync(installed(`files/${face.filename}`)));
    }
  });

  it("refuses size, SHA spelling and noncanonical base64 before decoding or allocation", async () => {
    const decode = vi.fn(() => {
      throw new Error("must not decode");
    });
    vi.stubGlobal("atob", decode);
    const face = VISUALIZATION_FONT_DATA[0]!;
    const candidates = [
      { payload: face.base64, expected: { ...face, byteLength: 76249 } },
      { payload: face.base64, expected: { ...face, byteLength: 47 } },
      { payload: face.base64, expected: { ...face, byteLength: NaN } },
      { payload: face.base64, expected: { ...face, sha256: "A".repeat(64) } },
      { payload: face.base64 + "A", expected: face },
      { payload: "!" + face.base64.slice(1), expected: face },
    ];
    for (const candidate of candidates)
      await expect(
        decodeVisualizationFontBytes(candidate.payload, candidate.expected),
      ).rejects.toThrow(unavailable);
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses decoded length, padding bits, WOFF2/header corruption and digest mismatch", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const face = VISUALIZATION_FONT_DATA[1]!;
    const bytes = Buffer.from(face.base64, "base64");
    const corrupt = (offset: number) => {
      const changed = Buffer.from(bytes);
      changed[offset] = changed[offset]! ^ 1;
      return changed.toString("base64");
    };
    const padding = face.base64.slice(0, -2) + "B=";
    for (const payload of [
      bytes.subarray(0, -1).toString("base64"),
      padding,
      corrupt(0),
      corrupt(8),
      corrupt(48),
    ])
      await expect(decodeVisualizationFontBytes(payload, face)).rejects.toThrow(unavailable);
  });

  it("returns before touching font, crypto or decoding APIs for an external App", async () => {
    const decode = vi.fn(() => {
      throw new Error("App must not decode");
    });
    const constructor = vi.fn(() => {
      throw new Error("App must not construct");
    });
    vi.stubGlobal("atob", decode);
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("FontFace", constructor);
    expect(await loadGeneratedVisualizationFontFaces("mcp-app")).toEqual([]);
    expect(decode).not.toHaveBeenCalled();
    expect(constructor).not.toHaveBeenCalled();
  });

  it("loads exactly four fixed binary faces but never adds them to a document or fetches", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const inputs: { family: string; bytes: ArrayBuffer; descriptors: FontFaceDescriptors }[] = [];
    class FixedFace {
      status = "unloaded";
      constructor(family: string, bytes: ArrayBuffer, descriptors: FontFaceDescriptors) {
        inputs.push({ family, bytes, descriptors });
      }
      async load() {
        this.status = "loaded";
        return this;
      }
    }
    const network = vi.fn(() => {
      throw new Error("must not fetch");
    });
    const add = vi.fn();
    vi.stubGlobal("fetch", network);
    vi.stubGlobal("document", { fonts: { add } });
    const faces = await loadGeneratedVisualizationFontFaces(
      "generated",
      FixedFace as unknown as typeof FontFace,
    );
    expect(faces).toHaveLength(4);
    expect(Object.isFrozen(faces)).toBe(true);
    expect(inputs.map(({ family, descriptors }) => ({ family, ...descriptors }))).toEqual(
      VISUALIZATION_FONT_DATA.map((face) => ({
        family: "DM Sans Variable",
        style: face.style,
        weight: face.weight,
        unicodeRange: face.unicodeRange,
        display: "swap",
      })),
    );
    inputs.forEach((input, index) =>
      expect(Buffer.from(input.bytes)).toEqual(
        Buffer.from(VISUALIZATION_FONT_DATA[index]!.base64, "base64"),
      ),
    );
    expect(network).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("requires the exact readable license commitment before any face construction", async () => {
    const digest = vi.fn(async (_algorithm: string, _bytes: ArrayBuffer) => new ArrayBuffer(32));
    vi.stubGlobal("crypto", { subtle: { digest } });
    const constructor = vi.fn();
    await expect(
      loadGeneratedVisualizationFontFaces("generated", constructor as unknown as typeof FontFace),
    ).rejects.toThrow(unavailable);
    expect(constructor).not.toHaveBeenCalled();
    expect(digest).toHaveBeenCalledTimes(1);
    const licenseBytes = digest.mock.calls[0]?.[1] as ArrayBuffer | undefined;
    expect(licenseBytes && Buffer.from(licenseBytes).toString("utf8")).toBe(
      VISUALIZATION_FONT_LICENSE,
    );
  });

  it("refuses missing APIs and parser failure without publishing a partial face set", async () => {
    vi.stubGlobal("FontFace", undefined);
    await expect(loadGeneratedVisualizationFontFaces("generated")).rejects.toThrow(unavailable);
    vi.stubGlobal("crypto", webcrypto);
    const construct = vi.fn();
    class FailedFace {
      status = "unloaded";
      constructor() {
        construct();
      }
      async load() {
        throw new Error("private parser details");
      }
    }
    await expect(
      loadGeneratedVisualizationFontFaces("generated", FailedFace as unknown as typeof FontFace),
    ).rejects.toThrow(unavailable);
    expect(construct).toHaveBeenCalledTimes(1);
  });
});
