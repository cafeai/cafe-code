import type { RepositoryIdentity } from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface RepositoryIdentityResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("cafecode/project/Services/RepositoryIdentityResolver") {}
