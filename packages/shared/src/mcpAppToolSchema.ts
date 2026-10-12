import { ownRecord } from "./mcpAppProtocol.ts";
import { encodeBoundedMcpAppJson, readBoundedMcpAppJson } from "./mcpAppJson.ts";

/** Finite JSON Schema admission, never an executable/regex/remote-ref evaluator.
 * Unsupported constraints refuse, rather than silently relaxing the schema.
 * The originating MCP server remains the final validator of its native input. */
export function validateMcpAppToolArguments(schema: unknown, input: unknown): boolean {
  try {
    // Admission precedes whole-object serialization. Otherwise toJSON/getters
    // could execute or a huge catalogue could allocate before the work fence.
    // Validate the bounded decoded snapshots, not the mutable caller objects.
    const schemaJson = encodeBoundedMcpAppJson(schema);
    if (schemaJson === undefined) return false;
    const inputJson = encodeBoundedMcpAppJson(input);
    if (inputJson === undefined) return false;
    const safeSchema = readBoundedMcpAppJson(schemaJson);
    const safeInput = readBoundedMcpAppJson(inputJson);
    if (!safeSchema.ok || !safeInput.ok) return false;
    const root = ownRecord(safeSchema.value);
    if (!root) return false;
    let budget = 4096;
    const allowed = new Set([
      "title",
      "description",
      "default",
      "examples",
      "deprecated",
      "readOnly",
      "writeOnly",
      "$schema",
      "$id",
      "$defs",
      "type",
      "enum",
      "const",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minProperties",
      "maxProperties",
      "anyOf",
      "oneOf",
      "allOf",
      "$ref",
    ]);
    const types = new Set(["null", "object", "array", "integer", "number", "string", "boolean"]);
    let schemaBudget = 4096;
    // Audit every declared schema branch before testing the chosen value. A
    // permissive anyOf branch cannot hide an unsupported regex/remote reference
    // or malformed type in an unexercised branch/property/definition.
    const preflight = (definition: unknown, depth: number): boolean => {
      if (--schemaBudget < 0 || depth > 16) return false;
      if (typeof definition === "boolean") return true;
      const rule = ownRecord(definition);
      if (!rule || Object.keys(rule).some((name) => !allowed.has(name))) return false;
      if (rule.type !== undefined) {
        const declared = Array.isArray(rule.type) ? rule.type : [rule.type];
        if (
          !declared.length ||
          declared.length > 7 ||
          new Set(declared).size !== declared.length ||
          declared.some((name) => typeof name !== "string" || !types.has(name))
        )
          return false;
      }
      if (
        rule.enum !== undefined &&
        (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 64)
      )
        return false;
      for (const name of [
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "minProperties",
        "maxProperties",
      ])
        if (
          rule[name] !== undefined &&
          (typeof rule[name] !== "number" || !Number.isSafeInteger(rule[name]) || rule[name] < 0)
        )
          return false;
      for (const name of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
        if (
          rule[name] !== undefined &&
          (typeof rule[name] !== "number" || !Number.isFinite(rule[name]))
        )
          return false;
      if (
        rule.required !== undefined &&
        (!Array.isArray(rule.required) ||
          rule.required.length > 256 ||
          new Set(rule.required).size !== rule.required.length ||
          rule.required.some((name) => typeof name !== "string"))
      )
        return false;
      if (rule.$ref !== undefined) {
        if (typeof rule.$ref !== "string" || !/^#\/\$defs\/[A-Za-z0-9_-]{1,100}$/.test(rule.$ref))
          return false;
        const defs = ownRecord(root.$defs);
        if (!defs || !Object.hasOwn(defs, rule.$ref.slice(8))) return false;
      }
      for (const name of ["properties", "$defs"])
        if (rule[name] !== undefined) {
          const definitions = ownRecord(rule[name]);
          if (
            !definitions ||
            Object.keys(definitions).length > 256 ||
            !Object.values(definitions).every((child) => preflight(child, depth + 1))
          )
            return false;
        }
      for (const name of ["items", "additionalProperties"])
        if (rule[name] !== undefined && !preflight(rule[name], depth + 1)) return false;
      for (const name of ["allOf", "anyOf", "oneOf"])
        if (rule[name] !== undefined) {
          const alternatives = rule[name];
          if (
            !Array.isArray(alternatives) ||
            !alternatives.length ||
            alternatives.length > 8 ||
            !alternatives.every((child) => preflight(child, depth + 1))
          )
            return false;
        }
      return true;
    };
    if (!preflight(root, 0)) return false;
    const visit = (definition: unknown, value: unknown, depth: number): boolean => {
      if (--budget < 0 || depth > 16) return false;
      if (typeof definition === "boolean") return definition;
      const rule = ownRecord(definition);
      if (!rule || Object.keys(rule).some((key) => !allowed.has(key))) return false;
      if (rule.$ref !== undefined) {
        if (typeof rule.$ref !== "string" || !/^#\/\$defs\/[A-Za-z0-9_-]{1,100}$/.test(rule.$ref))
          return false;
        const definitions = ownRecord(root.$defs);
        const name = rule.$ref.slice(8);
        if (
          !definitions ||
          !Object.hasOwn(definitions, name) ||
          !visit(definitions[name], value, depth + 1)
        )
          return false;
      }
      for (const branch of ["allOf", "anyOf", "oneOf"] as const)
        if (rule[branch] !== undefined) {
          const alternatives = rule[branch];
          if (!Array.isArray(alternatives) || !alternatives.length || alternatives.length > 8)
            return false;
          const matches = alternatives
            .map((alternative) => visit(alternative, value, depth + 1))
            .filter(Boolean).length;
          if (
            branch === "allOf"
              ? matches !== alternatives.length
              : branch === "oneOf"
                ? matches !== 1
                : matches === 0
          )
            return false;
        }
      const type = (name: unknown) =>
        name === "null"
          ? value === null
          : name === "object"
            ? !!ownRecord(value)
            : name === "array"
              ? Array.isArray(value)
              : name === "integer"
                ? Number.isSafeInteger(value)
                : name === "number"
                  ? typeof value === "number" && Number.isFinite(value)
                  : name === "string"
                    ? typeof value === "string"
                    : name === "boolean"
                      ? typeof value === "boolean"
                      : false;
      if (
        rule.type !== undefined &&
        !(Array.isArray(rule.type)
          ? rule.type.length <= 7 && rule.type.some(type)
          : type(rule.type))
      )
        return false;
      if (
        rule.enum !== undefined &&
        (!Array.isArray(rule.enum) ||
          rule.enum.length > 64 ||
          !rule.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value)))
      )
        return false;
      if (Object.hasOwn(rule, "const") && JSON.stringify(rule.const) !== JSON.stringify(value))
        return false;
      const bound = (key: string, actual: number, lower: boolean) =>
        rule[key] === undefined ||
        (typeof rule[key] === "number" &&
          Number.isFinite(rule[key]) &&
          (lower ? actual >= rule[key] : actual <= rule[key]));
      if (typeof value === "string") {
        let length = 0;
        for (const _character of value) length += 1;
        if (!bound("minLength", length, true) || !bound("maxLength", length, false)) return false;
      }
      if (typeof value === "number") {
        if (!bound("minimum", value, true) || !bound("maximum", value, false)) return false;
        if (
          rule.exclusiveMinimum !== undefined &&
          (typeof rule.exclusiveMinimum !== "number" ||
            !Number.isFinite(rule.exclusiveMinimum) ||
            value <= rule.exclusiveMinimum)
        )
          return false;
        if (
          rule.exclusiveMaximum !== undefined &&
          (typeof rule.exclusiveMaximum !== "number" ||
            !Number.isFinite(rule.exclusiveMaximum) ||
            value >= rule.exclusiveMaximum)
        )
          return false;
      }
      if (
        Array.isArray(value) &&
        (value.length > 256 ||
          !bound("minItems", value.length, true) ||
          !bound("maxItems", value.length, false) ||
          (rule.items !== undefined &&
            !value.every((entry) => visit(rule.items, entry, depth + 1))))
      )
        return false;
      const object = ownRecord(value);
      if (object) {
        const keys = Object.keys(object);
        if (
          keys.length > 256 ||
          !bound("minProperties", keys.length, true) ||
          !bound("maxProperties", keys.length, false)
        )
          return false;
        const properties = rule.properties === undefined ? {} : ownRecord(rule.properties);
        if (!properties) return false;
        if (
          rule.required !== undefined &&
          (!Array.isArray(rule.required) ||
            rule.required.length > 256 ||
            !rule.required.every((name) => typeof name === "string" && Object.hasOwn(object, name)))
        )
          return false;
        for (const name of keys) {
          if (Object.hasOwn(properties, name)) {
            if (!visit(properties[name], object[name], depth + 1)) return false;
          } else if (rule.additionalProperties === false) return false;
          else if (
            rule.additionalProperties !== undefined &&
            !visit(rule.additionalProperties, object[name], depth + 1)
          )
            return false;
        }
      }
      return true;
    };
    return visit(root, safeInput.value, 0);
  } catch {
    return false;
  }
}
