import { createRequire } from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Primitive from "effect/unstable/cli/Primitive";
import { describe, expect } from "vitest";

interface TomlOptions {
  readonly maxDepth?: number;
  readonly bigint?: boolean;
}

type ParseToml = (contents: string, options?: TomlOptions) => unknown;

/**
 * Resolve from each actual consumer, rather than whichever TOML happens to be
 * hoisted beside this test. In particular, the pre-update Effect dependency can
 * retain its own 4.x copy while the server already resolves 5.x.
 */
function consumerParser(require: NodeJS.Require): ParseToml {
  const loaded: unknown = require("toml");
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("parse" in loaded) ||
    typeof loaded.parse !== "function"
  )
    throw new Error("The consumer's TOML parser has no parse function.");
  const parse = loaded.parse;
  return (contents, options) =>
    Reflect.apply(parse, loaded, options === undefined ? [contents] : [contents, options]);
}

const scriptRequire = createRequire(import.meta.url);
const consumers = [
  {
    name: "Effect CLI dependency",
    parse: consumerParser(createRequire(scriptRequire.resolve("effect/unstable/cli/Primitive"))),
  },
  {
    name: "server dependency",
    parse: consumerParser(createRequire(new URL("../apps/server/package.json", import.meta.url))),
  },
];

const representative = String.raw`# The comment and a hash inside a string have different meanings.
label = "Cafe # Code" # trailing comment
safe = 42
negative = -17
hex = 0x2a
ratio = 1.25
enabled = true
literal = 'C:\fixture\new # literal'
values = [1, 2, 3]
point = { x = 1.25, y = -2.5 }
offset = 1979-05-27T07:32:00-08:00
local_date = 1979-05-27
local_time = 07:32:00
local_datetime = 1979-05-27T07:32:00
[owner]
name = "Ada"
[database.settings]
port = 5432
"literal.key" = "one key"
[[workers]]
name = "first"
enabled = true
[[workers]]
name = "second"
enabled = false
`;

function table(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("The parsed TOML value is not a table.");
  return value as Record<string, unknown>;
}

function expectRepresentative(value: unknown): void {
  const root = table(value);
  expect(root.label).toBe("Cafe # Code");
  expect(root.safe).toBe(42);
  expect(root.negative).toBe(-17);
  expect(root.hex).toBe(42);
  expect(root.ratio).toBe(1.25);
  expect(root.enabled).toBe(true);
  expect(root.literal).toBe(String.raw`C:\fixture\new # literal`);
  expect(root.values).toEqual([1, 2, 3]);
  expect(root.point).toEqual({ x: 1.25, y: -2.5 });
  expect(table(root.owner).name).toBe("Ada");
  expect(table(table(root.database).settings)).toEqual({ port: 5432, "literal.key": "one key" });
  expect(root.workers).toEqual([
    { name: "first", enabled: true },
    { name: "second", enabled: false },
  ]);
  // Neither consumer opts into Temporal. Preserve the established Date/string
  // representations instead of mistaking a successful parse for compatibility.
  expect(root.offset).toBeInstanceOf(Date);
  if (!(root.offset instanceof Date)) throw new Error("The offset date-time is not a Date.");
  expect(root.offset.toISOString()).toBe("1979-05-27T15:32:00.000Z");
  expect(root.local_date).toBe("1979-05-27");
  expect(root.local_time).toBe("07:32:00");
  expect(root.local_datetime).toBe("1979-05-27T07:32:00");
}

describe.each(consumers)("TOML security compatibility: $name", ({ parse }) => {
  it("preserves default safe numbers, dates, tables, arrays and literal strings", () => {
    expectRepresentative(parse(representative));
  });

  it.each([
    'name = "unterminated',
    'name = "first"\nname = "second"\n',
    "[item]\nvalue = 1\n[item]\nvalue = 2\n",
    'item = { name = "first", name = "second" }\n',
    "item.value = 1\nitem = 2\n",
  ])("continues to reject malformed or duplicate definitions (%#)", (contents) => {
    expect(() => parse(contents)).toThrow();
  });

  it("retains prototype-looking keys as own data without changing native prototypes", () => {
    const key = "cafeTomlSecurityCanary";
    const before = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const root = table(
      parse(
        '["__proto__"]\ncafeTomlSecurityCanary = "own data"\n[constructor.prototype]\ncafeTomlSecurityCanary = "also own data"\n',
      ),
    );
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.getPrototypeOf(table(root.__proto__))).toBeNull();
    expect(table(root.__proto__)[key]).toBe("own data");
    expect(table(table(root.constructor).prototype)[key]).toBe("also own data");
    expect(Object.getOwnPropertyDescriptor(Object.prototype, key)).toEqual(before);
    expect(() => parse("items = []\nitems.__proto__.cafeTomlSecurityCanary = true\n")).toThrow();
    expect(Object.getOwnPropertyDescriptor(Object.prototype, key)).toEqual(before);
  });

  it("rejects unsafe default integers instead of silently rounding them", () => {
    // This is an intentional migration boundary: 4.x could round these valid
    // int64 values. The security override must not reintroduce that behavior.
    expect(() => parse("integer = 9007199254740992\n")).toThrow();
    expect(() => parse("integer = -9007199254740992\n")).toThrow();
    expect(table(parse("integer = 9007199254740991\n")).integer).toBe(9007199254740991);
  });
});

describe("server TOML configuration options", () => {
  const parse = consumers[1]!.parse;
  // Keep the actual server configuration's options literal: the parser must
  // preserve every signed int64 value without relaxing its nesting boundary.
  const options: TomlOptions = { maxDepth: 80, bigint: true };

  it("retains full signed int64 values and keeps floats and dates in their ordinary form", () => {
    const root = table(
      parse(
        "largest = 9223372036854775807\nsmallest = -9223372036854775808\nhex = 0x7fff_ffff_ffff_ffff\nsafe = 3\nfloat = 1.25\ndate = 1979-05-27\n",
        options,
      ),
    );
    expect(root.largest).toBe(9223372036854775807n);
    expect(root.smallest).toBe(-9223372036854775808n);
    expect(root.hex).toBe(9223372036854775807n);
    expect(root.safe).toBe(3n);
    expect(root.float).toBe(1.25);
    expect(root.date).toBe("1979-05-27");
  });

  it.each([
    "integer = 9223372036854775808\n",
    "integer = -9223372036854775809\n",
    `nested = ${"[".repeat(81)}0${"]".repeat(81)}\n`,
  ])("rejects out-of-range or over-depth configuration input (%#)", (contents) => {
    expect(() => parse(contents, options)).toThrow();
  });
});

/** Use only an exact scoped temporary file; no user/provider configuration is read. */
const parseThroughEffectCli = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-toml-security-" });
    const file = path.join(root, "fixture.toml");
    yield* fs.writeFileString(file, contents);
    return yield* Primitive.fileParse({ format: "toml" }).parse(file);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("keeps the public Effect CLI file parser's ordinary TOML behavior", () =>
  Effect.gen(function* () {
    expectRepresentative(yield* parseThroughEffectCli(representative));
  }),
);

it.effect("returns a failure through the public Effect CLI parser for an unsafe integer", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(parseThroughEffectCli("integer = 9007199254740992\n"));
    expect(Exit.isFailure(result)).toBe(true);
  }),
);
