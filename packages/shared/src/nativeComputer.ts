import * as Schema from "effect/Schema";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(64 * 1024));
const Query = Schema.String.check(Schema.isMaxLength(512));
const Url = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const FilePath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Pixel = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Point = Schema.Struct({ x: Pixel, y: Pixel }).annotate(strict);
const Element = Schema.optionalKey(Id);
const View = Schema.Literals(["accessibility", "screenshot", "both"]);
const observation = {
  view: Schema.optionalKey(View),
  query: Schema.optionalKey(Query),
  full: Schema.optionalKey(Schema.Boolean),
};

export const ComputerSelect = Schema.Union([
  Schema.Struct({
    app: Id,
    window_id: Schema.optionalKey(PositiveInt),
    browser: Schema.optionalKey(Schema.Boolean),
    tab_id: Schema.optionalKey(Id),
    ...observation,
  }).annotate(strict),
  Schema.Struct({
    pid: PositiveInt,
    window_id: Schema.optionalKey(PositiveInt),
    browser: Schema.optionalKey(Schema.Boolean),
    tab_id: Schema.optionalKey(Id),
    ...observation,
  }).annotate(strict),
  Schema.Struct({ target_id: Id, tab_id: Id, ...observation }).annotate(strict),
]);
export type ComputerSelect = typeof ComputerSelect.Type;

export const ComputerObserve = Schema.Struct({ target: Id, ...observation }).annotate(strict);
export type ComputerObserve = typeof ComputerObserve.Type;

export const ComputerAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("click"),
    element: Element,
    point: Schema.optionalKey(Point),
    button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
    count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
  }).annotate(strict),
  Schema.Struct({
    type: Schema.Literal("type"),
    text: Text,
    element: Element,
    replace: Schema.optionalKey(Schema.Boolean),
  }).annotate(strict),
  Schema.Struct({ type: Schema.Literal("paste"), text: Text, element: Element }).annotate(strict),
  Schema.Struct({ type: Schema.Literal("set_value"), element: Id, value: Text }).annotate(strict),
  Schema.Struct({
    type: Schema.Literal("key"),
    keys: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
    element: Element,
  }).annotate(strict),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.optionalKey(PositiveInt.check(Schema.isBetween({ minimum: 1, maximum: 2000 }))),
    element: Element,
    point: Schema.optionalKey(Point),
  }).annotate(strict),
  Schema.Struct({ type: Schema.Literal("drag"), from: Point, to: Point }).annotate(strict),
  Schema.Struct({ type: Schema.Literal("navigate"), url: Url }).annotate(strict),
  Schema.Struct({
    type: Schema.Literal("files"),
    element: Id,
    files: Schema.Array(FilePath).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  }).annotate(strict),
]);
export type ComputerAction = typeof ComputerAction.Type;

export const ComputerAct = Schema.Struct({
  target: Id,
  actions: Schema.Array(ComputerAction).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  ...observation,
}).annotate(strict);
export type ComputerAct = typeof ComputerAct.Type;

export const ComputerAdvanced = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("list"), query: Schema.optionalKey(Query) }).annotate(
    strict,
  ),
  Schema.Struct({
    operation: Schema.Literal("call"),
    name: Id,
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }).annotate(strict),
]);
export type ComputerAdvanced = typeof ComputerAdvanced.Type;

const schemas = {
  computer_select: ComputerSelect,
  computer_observe: ComputerObserve,
  computer_act: ComputerAct,
  computer_advanced: ComputerAdvanced,
};
const descriptions = {
  computer_select:
    "Bind an app by name/bundle ID or exact pid/window, or a connected browser tab. Returns a target handle and initial state; reuse the handle. Ambiguous windows/tabs are returned for explicit selection. browser:true connects supported existing profiles without creating a logged-out profile.",
  computer_observe:
    "Read a bound target's accessibility state, screenshot, or both. State changes may be diffed; full:true returns every current element. Returned element handles are fresh. Accessibility-only reads clear pixel grounding; request both before coordinate input.",
  computer_act:
    "Run up to 16 predictable actions on one bound target, then return fresh state. Use current element handles or screenshot points. The host routes input and stops at failures, partial/uncertain effects or revoked access; never replay uncertain input. Pixel actions require a fresh screenshot. Paste preserves plain-text clipboard only; unsupported formats refuse before writing. Set value does not prove a web app accepted an AX echo.",
  computer_advanced:
    "Discover reviewed native operations with operation:list and an optional query; operation:call invokes one with its advertised arguments. Use for menus, bounded verification, browser setup and uncommon controls. Never bypasses computer-use admission. Afterwards observe the bound target again before using old elements or pixels.",
};

export const COMPUTER_CONTROL_TOOLS: readonly {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}[] = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof descriptions],
  inputSchema: { ...Schema.toJsonSchemaDocument(schema).schema, type: "object" },
  annotations: {
    readOnlyHint: name === "computer_observe",
    destructiveHint: name === "computer_advanced" || name === "computer_act",
    idempotentHint: name === "computer_observe",
    openWorldHint: true,
  },
}));

/** Use the same schemas for publication and admission. Whole-batch decoding
 * happens before any app lookup or physical input. Legacy native validation
 * additionally rejects reserved transport/file-output arguments recursively. */
export const decodeComputerSelect = Schema.decodeUnknownSync(ComputerSelect);
export const decodeComputerObserve = Schema.decodeUnknownSync(ComputerObserve);
export const decodeComputerAct = Schema.decodeUnknownSync(ComputerAct);
export const decodeComputerAdvanced = Schema.decodeUnknownSync(ComputerAdvanced);
const decoders = {
  computer_select: decodeComputerSelect,
  computer_observe: decodeComputerObserve,
  computer_act: decodeComputerAct,
  computer_advanced: decodeComputerAdvanced,
};
export function validateComputerCall(name: string, input: unknown): void {
  decoders[name as keyof typeof decoders]?.(input);
}
