import type {
  AuthSessionId,
  AuthTwoFactorStatus,
  AuthTwoFactorEnrollment,
  AuthTwoFactorEnabled,
} from "@cafecode/contracts/auth";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AuthError } from "./ServerAuth.ts";

export interface TwoFactorServiceShape {
  readonly status: Effect.Effect<AuthTwoFactorStatus, AuthError>;
  readonly begin: (owner: AuthSessionId) => Effect.Effect<AuthTwoFactorEnrollment, AuthError>;
  readonly enable: (
    owner: AuthSessionId,
    code: string,
  ) => Effect.Effect<AuthTwoFactorEnabled, AuthError>;
  readonly disable: (code: string) => Effect.Effect<void, AuthError>;
  readonly verify: (code: string | undefined) => Effect.Effect<void, AuthError>;
}

export class TwoFactorService extends Context.Service<TwoFactorService, TwoFactorServiceShape>()(
  "cafecode/auth/Services/TwoFactorService",
) {}
