/**
 * ProviderSessionRuntimeRepository - Repository interface for provider runtime sessions.
 *
 * Owns persistence operations for provider runtime metadata and resume cursors.
 *
 * @module ProviderSessionRuntimeRepository
 */
import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProviderSessionRuntimeRepositoryError } from "../Errors.ts";

export const ProviderSessionRuntime = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  /**
   * User-defined routing key for the configured provider instance that
   * owns this session. Nullable only at the storage/migration boundary:
   * rows persisted before the driver/instance split carry only
   * `providerName`. Repository consumers must materialize a concrete
   * instance id before routing.
   */
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
});
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type;

/**
 * Immutable routing provenance for one provider-owned nested-agent history.
 *
 * This state deliberately lives beside, rather than inside, the mutable root
 * session row. Switching a Cafe thread to another provider must not cause an
 * ended Codex child to be sent to Claude (or vice versa). The resume cursor and
 * cwd are server-private and never enter renderer-visible activity payloads.
 */
export const ProviderSubagentHistoryBinding = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  subagentId: Schema.String,
  historyId: Schema.NullOr(Schema.String),
  providerName: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  cwd: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProviderSubagentHistoryBinding = typeof ProviderSubagentHistoryBinding.Type;

export const GetProviderSubagentHistoryBindingInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  subagentId: Schema.String,
  historyId: Schema.NullOr(Schema.String),
});
export type GetProviderSubagentHistoryBindingInput =
  typeof GetProviderSubagentHistoryBindingInput.Type;

export const GetProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type;

export const DeleteProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type;

/**
 * ProviderSessionRuntimeRepositoryShape - Service API for provider runtime records.
 */
export interface ProviderSessionRuntimeRepositoryShape {
  /**
   * Insert or replace a provider runtime row.
   *
   * Upserts by canonical `threadId`, including JSON payload/cursor fields.
   */
  readonly upsert: (
    runtime: ProviderSessionRuntime,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  /**
   * Read provider runtime state by canonical thread id.
   */
  readonly getByThreadId: (
    input: GetProviderSessionRuntimeInput,
  ) => Effect.Effect<Option.Option<ProviderSessionRuntime>, ProviderSessionRuntimeRepositoryError>;

  /**
   * List all provider runtime rows.
   *
   * Returned in ascending last-seen order.
   */
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProviderSessionRuntime>,
    ProviderSessionRuntimeRepositoryError
  >;

  /**
   * Delete provider runtime state by canonical thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProviderSessionRuntimeInput,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  /** Idempotently capture immutable provider history routing for one child. */
  readonly upsertSubagentHistoryBinding: (
    binding: ProviderSubagentHistoryBinding,
  ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

  /** Resolve the exact persisted child/turn/history tuple, if retained. */
  readonly getSubagentHistoryBinding: (
    input: GetProviderSubagentHistoryBindingInput,
  ) => Effect.Effect<
    Option.Option<ProviderSubagentHistoryBinding>,
    ProviderSessionRuntimeRepositoryError
  >;
}

/**
 * ProviderSessionRuntimeRepository - Service tag for provider runtime persistence.
 */
export class ProviderSessionRuntimeRepository extends Context.Service<
  ProviderSessionRuntimeRepository,
  ProviderSessionRuntimeRepositoryShape
>()("cafecode/persistence/Services/ProviderSessionRuntime/ProviderSessionRuntimeRepository") {}
