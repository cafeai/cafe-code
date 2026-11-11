import type { EnvironmentId } from "@cafecode/contracts";
import {
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  writeBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
} from "../../clientPersistenceStorage";
import { loadRelayTarget, saveRelayTarget, removeRelayTarget } from "./storage";
import { decodeSavedRelaySecret, encodeSavedRelaySecret } from "./savedSecret";
import { RelayError } from "@cafecode/relay/errors";

const prefix = "relay:v1:";
const pointerId = (secret: string | null): string | undefined =>
  secret && /^relay:v1:[A-Za-z0-9_-]{43}$/.test(secret) ? secret.slice(prefix.length) : undefined;
const recordFor = (id: EnvironmentId) =>
  readBrowserSavedEnvironmentRegistry().find((record) => record.environmentId === id);

export async function readBrowserSavedSecret(id: EnvironmentId): Promise<string | null> {
  const secret = readBrowserSavedEnvironmentSecret(id);
  if (recordFor(id)?.transport !== "relay") return secret;
  const targetId = pointerId(secret);
  if (!targetId) return null;
  try {
    const { target, identity } = await loadRelayTarget(targetId);
    if (target.environmentId !== id) return null;
    return encodeSavedRelaySecret(target, identity);
  } catch {
    return null;
  }
}

/** The ordinary browser session-secret slot holds only a reference. Relay
 * device keys, bearer and reconnect tickets retain the existing nonextractable
 * IndexedDB wrapping key + tab-only authenticated ciphertext policy. */
export async function writeBrowserSavedSecret(id: EnvironmentId, secret: string): Promise<boolean> {
  const record = recordFor(id);
  if (record?.transport !== "relay") return writeBrowserSavedEnvironmentSecret(id, secret);
  const { target, identity } = decodeSavedRelaySecret(secret, id);
  await saveRelayTarget(target, identity, new AbortController().signal);
  const current = recordFor(id);
  if (
    current?.transport !== "relay" ||
    current.httpBaseUrl !== record.httpBaseUrl ||
    current.wsBaseUrl !== record.wsBaseUrl
  )
    throw new RelayError("UNAVAILABLE");
  return writeBrowserSavedEnvironmentSecret(id, prefix + target.id);
}

export async function removeBrowserSavedSecret(id: EnvironmentId): Promise<void> {
  const targetId =
    recordFor(id)?.transport === "relay"
      ? pointerId(readBrowserSavedEnvironmentSecret(id))
      : undefined;
  removeBrowserSavedEnvironmentSecret(id);
  if (targetId) await removeRelayTarget(targetId);
}
