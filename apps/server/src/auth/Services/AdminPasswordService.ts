import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class AdminPasswordError extends Data.TaggedError("AdminPasswordError")<{
  readonly message: string;
  readonly status?: 400 | 401 | 500;
  readonly cause?: unknown;
}> {}

export interface AdminPasswordServiceShape {
  readonly isConfigured: Effect.Effect<boolean, AdminPasswordError>;
  readonly setPassword: (password: string) => Effect.Effect<void, AdminPasswordError>;
  readonly clearPassword: Effect.Effect<void, AdminPasswordError>;
  readonly verifyPassword: (password: string) => Effect.Effect<boolean, AdminPasswordError>;
}

export class AdminPasswordService extends Context.Service<
  AdminPasswordService,
  AdminPasswordServiceShape
>()("cafecode/auth/Services/AdminPasswordService") {}
