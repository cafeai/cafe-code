import * as Schema from "effect/Schema";

/** Explicit composer selection, independent of ordinary prompt text. The
 * adapter still checks the exact live native command catalog and input token;
 * this descriptor never grants account, history or permission control. */
export const AxiomCommand = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/u)),
});
export type AxiomCommand = typeof AxiomCommand.Type;
