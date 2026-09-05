import {
  ChatFileAttachment,
  ChatImageAttachment,
  CommandId,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInteractionMode,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES,
  RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { StateStorage } from "../../lib/storage";

export const FOLLOW_UP_QUEUE_STORAGE_KEY = "cafe-code:follow-up-queue:v1";
export const MAX_PERSISTED_FOLLOW_UPS_PER_ENVIRONMENT = 64;
export const MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES = 80 * 1024 * 1024;
const MAX_PERSISTED_FOLLOW_UPS = 512;
const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const imageDataUrl = Schema.String.check(Schema.isMaxLength(14_000_000));
const persistedImage = Schema.Struct({ ...ChatImageAttachment.fields, dataUrl: imageDataUrl });
const dispatchIdentity = Schema.Struct({ commandId: CommandId, messageId: MessageId });
const persistedItem = Schema.Struct({
  id: boundedId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  promptText: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  images: Schema.Array(persistedImage).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  files: Schema.Array(ChatFileAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  provider: ProviderDriverKind,
  model: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  promptEffort: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  queuedAt: Schema.String.check(Schema.isMaxLength(64)),
  blocked: Schema.Boolean,
  dispatch: Schema.NullOr(dispatchIdentity),
});
const persistedQueue = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(persistedItem).check(Schema.isMaxLength(MAX_PERSISTED_FOLLOW_UPS)),
});
type PersistedItem = typeof persistedItem.Type;
type PersistedImage = typeof persistedImage.Type;
const decodeQueue = Schema.decodeUnknownSync(persistedQueue);
const decodeItem = Schema.decodeUnknownSync(persistedItem);

// File contents are immutable. Remember the exact encoded bytes produced by
// save/hydrate so synchronous claim admission can bind image contents, not just
// forgeable name/size metadata, without another asynchronous file read. Weak
// keys release their bounded payload when the composer/queue releases the File.
const knownImagePayloads = new WeakMap<File, string>();

export interface FollowUpQueuePersistenceItem {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly promptText: string;
  readonly images: readonly ComposerImageAttachment[];
  readonly files?: readonly ChatFileAttachment[];
  readonly provider: ProviderDriverKind;
  readonly model: string | null;
  readonly promptEffort: string | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly queuedAt: string;
  readonly blockedReason: string | null;
  readonly automaticSteerRetry?: unknown;
}

export interface FollowUpQueueClaim {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: string;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
}

export type FollowUpQueueItemScope = Pick<
  FollowUpQueueClaim,
  "environmentId" | "threadId" | "itemId"
>;

export interface HydratedFollowUpQueueItem extends Omit<
  FollowUpQueuePersistenceItem,
  "images" | "files" | "automaticSteerRetry"
> {
  readonly images: ComposerImageAttachment[];
  readonly files: ChatFileAttachment[];
  readonly providerModels: ReadonlyArray<ServerProvider["models"][number]>;
  readonly expanded: false;
  readonly automaticSteerRetry?: null;
  readonly dispatchState: "pending" | "claimed";
  readonly claimedDispatch?: { readonly commandId: CommandId; readonly messageId: MessageId };
}

export type FollowUpQueuePersistenceResult<A = void> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

const failure = (error: string): FollowUpQueuePersistenceResult<never> => ({ ok: false, error });
const success = <A>(value: A): FollowUpQueuePersistenceResult<A> => ({ ok: true, value });
const STORAGE_FAILURE =
  "Could not save the follow-up queue. Browser storage may be unavailable or full; keep this page open and try again.";
const INVALID_QUEUE =
  "Saved follow-up queue data is invalid or exceeds its safety limit. Existing data was left untouched.";
const CLAIMED_MESSAGE =
  "Delivery status is unknown after reload. Inspect the timeline before removing this queued message.";
const QUEUE_CHANGED =
  "This queued follow-up changed in another view. Reload and review it before trying again.";

function itemKey(item: { environmentId: EnvironmentId; threadId: ThreadId; id: string }): string {
  return JSON.stringify([item.environmentId, item.threadId, item.id]);
}

function claimKey(claim: FollowUpQueueItemScope): string {
  return itemKey({ ...claim, id: claim.itemId });
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Validate before allocating decoded bytes or creating any renderable URL. */
function validatedImagePayload(image: PersistedImage): string {
  const prefix = `data:${image.mimeType};base64,`;
  if (
    !/^image\/(?:png|jpeg|gif|webp)$/i.test(image.mimeType) ||
    !image.dataUrl.startsWith(prefix)
  ) {
    throw new Error(INVALID_QUEUE);
  }
  const encoded = image.dataUrl.slice(prefix.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(INVALID_QUEUE);
  }
  const decodedSize =
    (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (decodedSize !== image.sizeBytes || decodedSize > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error(INVALID_QUEUE);
  }
  return encoded;
}

function decodeImage(image: PersistedImage): Uint8Array<ArrayBuffer> {
  const binary = atob(validatedImagePayload(image));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateItemBounds(items: readonly PersistedItem[]): void {
  const seen = new Set<string>();
  const counts = new Map<EnvironmentId, number>();
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key) || !Number.isFinite(Date.parse(item.queuedAt)))
      throw new Error(INVALID_QUEUE);
    seen.add(key);
    const count = (counts.get(item.environmentId) ?? 0) + 1;
    if (count > MAX_PERSISTED_FOLLOW_UPS_PER_ENVIRONMENT) throw new Error(INVALID_QUEUE);
    counts.set(item.environmentId, count);
    const attachments = [...item.images, ...item.files];
    if (
      attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
      attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0) >
        PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      throw new Error(INVALID_QUEUE);
    }
  }
}

function validateItems(items: readonly PersistedItem[]): void {
  validateItemBounds(items);
  for (const item of items) {
    for (const image of item.images) validatedImagePayload(image);
  }
}

async function persistImage(image: ComposerImageAttachment): Promise<PersistedImage> {
  if (image.file.size !== image.sizeBytes || image.file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error(INVALID_QUEUE);
  }
  const bytes = new Uint8Array(await image.file.arrayBuffer());
  let binary = "";
  // Do not spread multi-megabyte images onto the JavaScript argument stack.
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  const payload = btoa(binary);
  knownImagePayloads.set(image.file, payload);
  return {
    type: "image",
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    dataUrl: `data:${image.mimeType};base64,${payload}`,
  };
}

function itemMetadata(item: FollowUpQueuePersistenceItem): PersistedItem {
  return decodeItem({
    id: item.id,
    environmentId: item.environmentId,
    threadId: item.threadId,
    promptText: item.promptText,
    images: item.images.map(({ id, name, mimeType, sizeBytes }) => ({
      type: "image",
      id,
      name,
      mimeType,
      sizeBytes,
      dataUrl: "",
    })),
    files: (item.files ?? []).map(({ type, id, name, mimeType, sizeBytes }) => ({
      type,
      id,
      name,
      mimeType,
      sizeBytes,
    })),
    provider: item.provider,
    model: item.model,
    promptEffort: item.promptEffort,
    modelSelection: item.modelSelection,
    runtimeMode: item.runtimeMode,
    interactionMode: item.interactionMode,
    queuedAt: item.queuedAt,
    blocked: item.blockedReason !== null,
    dispatch: null,
  });
}

function expectedIntent(item: FollowUpQueuePersistenceItem): PersistedItem {
  const metadata = itemMetadata(item);
  return {
    ...metadata,
    images: metadata.images.map((image, index) => {
      const source = item.images[index]!;
      const payload = knownImagePayloads.get(source.file);
      if (payload === undefined || source.file.size !== image.sizeBytes)
        throw new Error(QUEUE_CHANGED);
      return Object.assign({}, image, { dataUrl: `data:${image.mimeType};base64,${payload}` });
    }),
  };
}

function sameIntent(left: PersistedItem, right: PersistedItem): boolean {
  // Presentation-only blocking messages and the claim itself are not user
  // input. Every field that can change the dispatched request remains bound.
  return (
    JSON.stringify({ ...left, blocked: false, dispatch: null }) ===
    JSON.stringify({ ...right, blocked: false, dispatch: null })
  );
}

async function encodeItems(
  items: readonly FollowUpQueuePersistenceItem[],
): Promise<PersistedItem[]> {
  const sources = items.map((item) => item.images.map((image) => ({ ...image })));
  const encoded = decodeQueue({ version: 1, items: items.map(itemMetadata) }).items;
  validateItemBounds(encoded);
  // Reject the aggregate encoded budget before allocating any image contents.
  let encodedBytes = utf8Length(JSON.stringify({ version: 1, items: encoded }));
  for (const [index, item] of encoded.entries()) {
    for (const [imageIndex, image] of item.images.entries()) {
      const source = sources[index]![imageIndex]!;
      if (
        source.file.size !== image.sizeBytes ||
        !/^image\/(?:png|jpeg|gif|webp)$/i.test(image.mimeType)
      )
        throw new Error(INVALID_QUEUE);
      encodedBytes += `data:${image.mimeType};base64,`.length + Math.ceil(image.sizeBytes / 3) * 4;
    }
  }
  if (encodedBytes > MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES) throw new Error(INVALID_QUEUE);
  const complete: PersistedItem[] = [];
  for (const [index, item] of encoded.entries()) {
    const images: PersistedImage[] = [];
    for (const image of sources[index]!) images.push(await persistImage(image));
    complete.push({ ...item, images });
  }
  return complete;
}

function hydrateItem(item: PersistedItem): HydratedFollowUpQueueItem {
  return {
    id: item.id,
    environmentId: item.environmentId,
    threadId: item.threadId,
    promptText: item.promptText,
    images: item.images.map((image) => {
      const file = new File([decodeImage(image)], image.name, { type: image.mimeType });
      knownImagePayloads.set(file, validatedImagePayload(image));
      return {
        type: "image",
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        previewUrl: image.dataUrl,
        file,
      };
    }),
    files: item.files.map((file) => ({ ...file })),
    provider: item.provider,
    model: item.model,
    promptEffort: item.promptEffort,
    modelSelection: item.modelSelection,
    runtimeMode: item.runtimeMode,
    interactionMode: item.interactionMode,
    queuedAt: item.queuedAt,
    providerModels: [],
    expanded: false,
    blockedReason: item.dispatch
      ? CLAIMED_MESSAGE
      : item.blocked
        ? "Review this queued follow-up before sending."
        : null,
    dispatchState: item.dispatch ? "claimed" : "pending",
    ...(item.dispatch ? { claimedDispatch: item.dispatch } : {}),
  };
}

/**
 * A small durable projection over the same StateStorage interface as composer
 * drafts. Claims must be synchronous and verified before any provider command;
 * unlike a debounced draft write, a failed claim must stop dispatch. Callers use
 * each ordinary row's stable UUID as its command/message identity, so multiple
 * tabs racing the same saved row meet server-side idempotency/fingerprint checks.
 * Only an exact receipt or explicit user removal may settle a claimed row.
 */
export function createFollowUpQueuePersistence(storage?: StateStorage) {
  const selectedStorage = (): StateStorage => {
    // Do not substitute volatile memory when the browser denies storage: the
    // caller must never present an unsaved queue or claim as durable.
    if (storage) return storage;
    return localStorage;
  };
  let generation = 0;
  const read = (): PersistedItem[] => {
    const raw = selectedStorage().getItem(FOLLOW_UP_QUEUE_STORAGE_KEY);
    if (raw === null) return [];
    if (
      typeof raw !== "string" ||
      raw.length > MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES ||
      utf8Length(raw) > MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES
    ) {
      throw new Error(INVALID_QUEUE);
    }
    const decoded = decodeQueue(JSON.parse(raw));
    validateItems(decoded.items);
    return [...decoded.items];
  };
  const write = (items: readonly PersistedItem[]): void => {
    const decoded = decodeQueue({ version: 1, items });
    validateItems(decoded.items);
    const serialized = JSON.stringify(decoded);
    if (
      serialized.length > MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES ||
      utf8Length(serialized) > MAX_PERSISTED_FOLLOW_UP_QUEUE_BYTES
    ) {
      throw new Error(INVALID_QUEUE);
    }
    const target = selectedStorage();
    const result = target.setItem(FOLLOW_UP_QUEUE_STORAGE_KEY, serialized);
    if (
      (result !== null && typeof result === "object" && "then" in result) ||
      target.getItem(FOLLOW_UP_QUEUE_STORAGE_KEY) !== serialized
    ) {
      throw new Error(STORAGE_FAILURE);
    }
  };
  return {
    load(environmentId: EnvironmentId): FollowUpQueuePersistenceResult<{
      pending: HydratedFollowUpQueueItem[];
      claimed: HydratedFollowUpQueueItem[];
    }> {
      try {
        const items = read()
          .filter((item) => item.environmentId === environmentId)
          .map(hydrateItem);
        return success({
          pending: items.filter((item) => item.dispatchState === "pending"),
          claimed: items.filter((item) => item.dispatchState === "claimed"),
        });
      } catch {
        return failure(INVALID_QUEUE);
      }
    },
    async save(
      environmentId: EnvironmentId,
      items: readonly FollowUpQueuePersistenceItem[],
    ): Promise<FollowUpQueuePersistenceResult> {
      const currentGeneration = ++generation;
      try {
        const ordinary = items.filter((item) => item.automaticSteerRetry == null);
        if (
          ordinary.length > MAX_PERSISTED_FOLLOW_UPS_PER_ENVIRONMENT ||
          ordinary.some((item) => item.environmentId !== environmentId)
        )
          return failure(INVALID_QUEUE);
        const complete = await encodeItems(ordinary);
        // A claim, removal, or newer save that ran while image bytes were read
        // owns the newer state. Never let that stale async snapshot resurrect it.
        if (currentGeneration !== generation) return failure(QUEUE_CHANGED);
        const existing = read();
        const next = [...existing];
        for (const item of complete) {
          const previous = existing.find((entry) => itemKey(entry) === itemKey(item));
          // A save inserts new intent, never performs an implicit deletion or
          // overwrites an edit made in another mounted view. Editing is an
          // explicit compare-and-replace operation below; claims survive saves.
          if (previous?.dispatch) continue;
          if (previous && !sameIntent(previous, item)) return failure(QUEUE_CHANGED);
          if (!previous) next.push(item);
        }
        write(next);
        return success(undefined);
      } catch {
        return failure(STORAGE_FAILURE);
      }
    },
    async replacePending(
      expected: FollowUpQueuePersistenceItem,
      replacement: FollowUpQueuePersistenceItem,
    ): Promise<FollowUpQueuePersistenceResult> {
      const currentGeneration = ++generation;
      try {
        if (
          itemKey(expected) !== itemKey(replacement) ||
          expected.automaticSteerRetry != null ||
          replacement.automaticSteerRetry != null
        )
          return failure(QUEUE_CHANGED);
        // Capture the old image byte identity before an asynchronous encode can
        // yield to another view's edit, removal, or claim.
        const previousIntent = expectedIntent(expected);
        const [next] = await encodeItems([replacement]);
        if (currentGeneration !== generation) return failure(QUEUE_CHANGED);
        const items = read();
        const target = items.find((item) => itemKey(item) === itemKey(expected));
        if (!target || target.dispatch || !sameIntent(target, previousIntent))
          return failure(QUEUE_CHANGED);
        write(items.map((item) => (item === target ? next! : item)));
        return success(undefined);
      } catch {
        return failure(STORAGE_FAILURE);
      }
    },
    claim(
      claim: FollowUpQueueClaim,
      expected: FollowUpQueuePersistenceItem,
    ): FollowUpQueuePersistenceResult {
      ++generation;
      try {
        const items = read();
        const target = items.find((item) => itemKey(item) === claimKey(claim));
        if (!target) return failure("Save this queued follow-up before sending it.");
        if (target.dispatch !== null) return failure(CLAIMED_MESSAGE);
        if (itemKey(expected) !== claimKey(claim) || !sameIntent(target, expectedIntent(expected)))
          return failure(QUEUE_CHANGED);
        write(
          items.map((item) =>
            item === target
              ? Object.assign({}, item, {
                  dispatch: { commandId: claim.commandId, messageId: claim.messageId },
                })
              : item,
          ),
        );
        return success(undefined);
      } catch {
        return failure(STORAGE_FAILURE);
      }
    },
    removePending(scope: FollowUpQueueItemScope): FollowUpQueuePersistenceResult {
      ++generation;
      try {
        const items = read();
        const target = items.find((item) => itemKey(item) === claimKey(scope));
        if (!target) return success(undefined);
        // A persisted delivery attempt may only be cleared through the exact
        // command/message tuple, never by a stale ordinary-queue Remove action.
        if (target.dispatch !== null) return failure(CLAIMED_MESSAGE);
        write(items.filter((item) => item !== target));
        return success(undefined);
      } catch {
        return failure(STORAGE_FAILURE);
      }
    },
    settleClaim(claim: FollowUpQueueClaim): FollowUpQueuePersistenceResult {
      ++generation;
      try {
        const items = read();
        const target = items.find((item) => itemKey(item) === claimKey(claim));
        if (!target) return success(undefined);
        if (
          target.dispatch?.commandId !== claim.commandId ||
          target.dispatch.messageId !== claim.messageId
        )
          return failure(CLAIMED_MESSAGE);
        write(items.filter((item) => item !== target));
        return success(undefined);
      } catch {
        return failure(STORAGE_FAILURE);
      }
    },
  };
}
