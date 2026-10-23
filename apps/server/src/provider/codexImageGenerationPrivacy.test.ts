import * as Schema from "effect/Schema";
import { expect, it } from "vitest";

import { redactCodexImageGenerationMetadata } from "./codexImageGenerationPrivacy.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const OMITTED = "[Private image metadata omitted]";
const privateFields = {
  fileId: "private-image-attachment-sentinel",
  inputImages: [
    { path: "/private/image-input-sentinel.png", sha256: "private-image-digest-sentinel" },
  ],
};

it.each([
  { result: "legacy-inline-result" },
  { fileId: privateFields.fileId },
  { result: "", fileId: privateFields.fileId },
])(
  "projects each native image reference without changing permitted presentation: %j",
  (reference) => {
    const original = {
      type: "imageGeneration",
      id: "image-1",
      status: "completed",
      revisedPrompt: "Original user-visible prompt",
      savedPath: "/fixture/existing-output.png",
      transparentBackground: false,
      ...reference,
      inputImages: privateFields.inputImages,
    };
    const before = encodeJson(original);
    const projected = redactCodexImageGenerationMetadata(original);
    expect(projected).toEqual({
      type: "imageGeneration",
      id: "image-1",
      status: "completed",
      revisedPrompt: "Original user-visible prompt",
      savedPath: "/fixture/existing-output.png",
      transparentBackground: false,
      ...("result" in reference ? { result: reference.result } : {}),
    });
    expect(encodeJson(projected)).not.toContain("private-image-");
    expect(encodeJson(original)).toBe(before);
  },
);

it("redacts own image occurrences in arbitrary nested protocol/history containers", () => {
  const image = { type: "imageGeneration", id: "image-1", status: "completed", ...privateFields };
  const unrelated = { type: "ordinary-tool", fileId: "public-tool-id", inputImages: ["ordinary"] };
  const original = {
    method: "thread/read",
    result: { thread: { turns: [{ items: [image, unrelated], nested: { image } }] } },
  };
  const projected = redactCodexImageGenerationMetadata(original);
  expect(encodeJson(projected)).not.toContain("private-image-");
  expect(projected).toEqual({
    method: "thread/read",
    result: {
      thread: {
        turns: [
          {
            items: [{ type: "imageGeneration", id: "image-1", status: "completed" }, unrelated],
            nested: { image: { type: "imageGeneration", id: "image-1", status: "completed" } },
          },
        ],
      },
    },
  });
  expect(image).toHaveProperty("fileId", privateFields.fileId);
  expect(image).toHaveProperty("inputImages", privateFields.inputImages);
});

it("preserves safe non-image JSON and its identity", () => {
  const original = { fileId: "unrelated", items: [null, true, 2, "text", { type: "imageView" }] };
  expect(redactCodexImageGenerationMetadata(original)).toBe(original);
  expect(redactCodexImageGenerationMetadata(undefined)).toBeUndefined();
});

it("preserves retained data-property visibility when a private image field is removed", () => {
  const original = Object.defineProperty(
    { type: "imageGeneration", id: "image-1", ...privateFields },
    "revisedPrompt",
    { value: "retained nonenumerable prompt", enumerable: false },
  );
  const projected = redactCodexImageGenerationMetadata(original);
  if (projected === null || typeof projected !== "object") {
    throw new Error("Expected an observational image record.");
  }
  expect(Object.getOwnPropertyDescriptor(projected, "revisedPrompt")).toMatchObject({
    value: "retained nonenumerable prompt",
    enumerable: false,
  });
  expect(Object.getOwnPropertyDescriptor(projected, "id")).toMatchObject({
    value: "image-1",
    enumerable: true,
  });
  expect(Object.hasOwn(projected, "fileId")).toBe(false);
  expect(Object.hasOwn(projected, "inputImages")).toBe(false);
  expect(encodeJson(projected)).not.toContain("private-image-");
  expect(Object.getOwnPropertyDescriptor(original, "revisedPrompt")?.enumerable).toBe(false);
});

it("refuses proxies before any reflection trap, including nested and revoked proxies", () => {
  let traps = 0;
  const trapped = new Proxy(
    {},
    {
      get: () => {
        traps += 1;
        return undefined;
      },
      getPrototypeOf: () => {
        traps += 1;
        return null;
      },
      getOwnPropertyDescriptor: () => {
        traps += 1;
        return undefined;
      },
      ownKeys: () => {
        traps += 1;
        return [];
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  expect(redactCodexImageGenerationMetadata(trapped)).toBe(OMITTED);
  expect(redactCodexImageGenerationMetadata({ nested: trapped })).toEqual({ nested: OMITTED });
  expect(redactCodexImageGenerationMetadata(revoked.proxy)).toBe(OMITTED);
  expect(traps).toBe(0);
});

it("never invokes accessors or string/JSON coercion during refusal", () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, "type", {
    get: () => {
      reads += 1;
      return "imageGeneration";
    },
  });
  const nested = Object.defineProperty({ type: "ordinary" }, "secret", {
    get: () => {
      reads += 1;
      return "private-image-accessor-sentinel";
    },
  });
  const coercible = {
    toJSON: () => {
      reads += 1;
      return "private-image-coercion-sentinel";
    },
  };
  expect(redactCodexImageGenerationMetadata(accessor)).toBe(OMITTED);
  expect(redactCodexImageGenerationMetadata(nested)).toBe(OMITTED);
  expect(encodeJson(redactCodexImageGenerationMetadata(coercible))).not.toContain("private-image-");
  const omittedAccessor = Object.defineProperty(
    { type: "imageGeneration", id: "image-1" },
    "inputImages",
    {
      get: () => {
        reads += 1;
        return "private-image-input-sentinel";
      },
    },
  );
  expect(redactCodexImageGenerationMetadata(omittedAccessor)).toEqual({
    type: "imageGeneration",
    id: "image-1",
  });
  expect(reads).toBe(0);
});

it("uses own data discriminants and safe properties rather than inherited image identity", () => {
  const inherited = Object.create({ type: "imageGeneration" }) as object;
  expect(redactCodexImageGenerationMetadata(inherited)).toBe(OMITTED);
  const original: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(original, "__proto__", {
    value: { type: "imageGeneration", ...privateFields },
    enumerable: true,
  });
  const projected = redactCodexImageGenerationMetadata(original);
  expect(Object.getPrototypeOf(projected)).toBeNull();
  expect(Object.hasOwn(projected as object, "__proto__")).toBe(true);
  expect(encodeJson(projected)).not.toContain("private-image-");
});

it("bounds cyclic, excessively deep and excessively broad observational trees", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(redactCodexImageGenerationMetadata(cycle)).toEqual({ self: OMITTED });
  let deep: unknown = { type: "imageGeneration", ...privateFields };
  for (let index = 0; index < 40; index += 1) deep = { nested: deep };
  expect(encodeJson(redactCodexImageGenerationMetadata(deep))).toContain(OMITTED);
  expect(encodeJson(redactCodexImageGenerationMetadata(deep))).not.toContain("private-image-");
  expect(redactCodexImageGenerationMetadata(Array.from({ length: 50_001 }, () => null))).toBe(
    OMITTED,
  );
});
