import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("cafecode/no-inline-schema-compile");

describe("cafecode/no-inline-schema-compile", () => {
  rule.valid("allows supported schema compilation patterns", [
    `
      import { Schema } from "effect";

      const User = Schema.Struct({ name: Schema.String });
      const decodeUser = Schema.decodeUnknownEffect(User);

      export const parseUser = (input: unknown) => decodeUser(input);
    `,
    `
      import { Schema } from "effect";

      export const makeParser = <A, I>(schema: Schema.Codec<A, I>) => {
        const decode = Schema.decodeUnknownEffect(schema);
        return (input: unknown) => decode(input);
      };
    `,
    `
      import { Schema } from "effect";

      export const makePrettyJson = <S extends Schema.Top>(schema: S) =>
        Schema.fromJsonString(schema).pipe(
          Schema.encode({
            decode: Schema.String,
            encode: Schema.String,
          }),
        );
    `,
    `
      import { Schema } from "effect";

      export const parseWith = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
        Schema.decodeUnknownEffect(schema)(input);
    `,
  ]);

  rule.invalid(
    "reports avoidable schema compilation inside function bodies",
    [
      `
      import { Schema } from "effect";

      const User = Schema.Struct({ name: Schema.String });

      export const parseUser = (input: unknown) => Schema.decodeUnknownEffect(User)(input);
    `,
      `
      import { Schema } from "effect";

      export const parseUser = (input: unknown) =>
        Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String }))(input);
    `,
    ],
    (output) => {
      assert.match(output, /Hoist Schema\.decodeUnknownEffect/);
      assert.match(output, /inline schema literal and the compiled function/);
    },
  );
});
