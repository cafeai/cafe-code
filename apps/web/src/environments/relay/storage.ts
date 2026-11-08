import * as Schema from "effect/Schema";
import { canonicalBytes, Id16, Id32, SafeCounter, readCanonical } from "@cafecode/relay/protocol";
import { opaque, unopaque, unopaqueBounded, utf8, decodeUtf8 } from "@cafecode/relay/bytes";
import { privateIdentityBytes, restoreIdentity, type RelayIdentity } from "@cafecode/relay/crypto";
import { RelayError, requireRelay } from "@cafecode/relay/errors";
import type { SavedRelayTarget } from "./active";

const Target = Schema.Struct({
  id: Id32,
  networkId: Id32,
  rootPublicKey: Id32,
  bootstrapUrls: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
  minimumRevision: SafeCounter,
  hostPublicKey: Id32,
  environmentId: Schema.String.check(Schema.isMaxLength(128)),
  locator: Id32,
  preferredNodeId: Id32,
  bearerToken: Schema.String.check(Schema.isMaxLength(4096)),
  tickets: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        nodeId: Id32,
        registrationId: Id16,
        token: Id32,
        expiresAt: SafeCounter,
        admissionPrivateKey: Schema.String.check(Schema.isMaxLength(172)),
      }),
    ).check(Schema.isMaxLength(4)),
  ),
});
const Payload = Schema.Struct({
  target: Target,
  devicePrivateKey: Schema.String.check(Schema.isMaxLength(172)),
});
const maximum = 16_384;
const SessionRecord = Schema.Struct({
  version: Schema.Literal(1),
  iv: Schema.String.check(Schema.isMaxLength(16)),
  ciphertext: Schema.String.check(Schema.isMaxLength(21_867)),
});
const sessionKey = (id: string) => "cafe-relay-target:" + id;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("cafe-relay-viewers", 1);
    let active = true;
    const fail = () => {
      active = false;
      reject(new RelayError("UNAVAILABLE"));
    };
    request.onerror = fail;
    request.onblocked = fail;
    request.onupgradeneeded = () => {
      if (!active) {
        request.transaction?.abort();
        return;
      }
      request.result.createObjectStore("keys");
      request.result.createObjectStore("targets");
    };
    request.onsuccess = () => {
      if (!active) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
  });
}
function get(database: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, "readonly"),
      request = transaction.objectStore(store).get(key);
    transaction.onabort = transaction.onerror = () => reject(new RelayError("UNAVAILABLE"));
    transaction.oncomplete = () => resolve(request.result);
  });
}
async function wrappingKey(database: IDBDatabase): Promise<CryptoKey> {
  const existing = await get(database, "keys", "wrap-v1");
  if (existing !== undefined) {
    requireRelay(
      existing instanceof CryptoKey &&
        !existing.extractable &&
        existing.type === "secret" &&
        existing.algorithm.name === "AES-GCM" &&
        existing.usages.includes("encrypt") &&
        existing.usages.includes("decrypt"),
    );
    return existing;
  }
  const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  // add is no-overwrite. A concurrent page may win; re-read its exact key after
  // that transaction settles, rather than replace an existing wrapping key.
  await new Promise<void>((resolve) => {
    const transaction = database.transaction("keys", "readwrite");
    transaction.objectStore("keys").add(generated, "wrap-v1");
    transaction.oncomplete = transaction.onabort = transaction.onerror = () => resolve();
  });
  const key = await get(database, "keys", "wrap-v1");
  requireRelay(
    key instanceof CryptoKey &&
      !key.extractable &&
      key.type === "secret" &&
      key.algorithm.name === "AES-GCM",
  );
  return key;
}
function additionalData(id: string): Uint8Array<ArrayBuffer> {
  return utf8.encode("CafeCode/relay/browser-store/v1\0" + id);
}

export async function listRelayTargetIds(): Promise<readonly string[]> {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("targets", "readonly"),
        request = transaction.objectStore("targets").getAllKeys(undefined, 17);
      transaction.oncomplete = () => {
        try {
          requireRelay(request.result.length <= 16);
          resolve(
            request.result.map((key) => {
              requireRelay(typeof key === "string");
              unopaque(key, 32);
              return key;
            }),
          );
        } catch {
          reject(new RelayError("UNAVAILABLE"));
        }
      };
      transaction.onabort = transaction.onerror = () => reject(new RelayError("UNAVAILABLE"));
    });
  } finally {
    database.close();
  }
}

/** Same-origin endpoint code is trusted. This is wrapping, not XSS protection. */
export async function saveRelayTarget(
  target: SavedRelayTarget,
  identity: RelayIdentity,
  signal: AbortSignal,
): Promise<void> {
  requireRelay(!signal.aborted, "UNAVAILABLE");
  const bytes = canonicalBytes(
    { target, devicePrivateKey: opaque(privateIdentityBytes(identity)) },
    maximum,
  );
  const database = await open();
  try {
    requireRelay(!signal.aborted, "UNAVAILABLE");
    const key = await wrappingKey(database),
      iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(target.id) },
      key,
      bytes.slice(),
    );
    requireRelay(!signal.aborted, "UNAVAILABLE");
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("targets", "readwrite"),
        store = transaction.objectStore("targets"),
        count = store.count();
      count.onsuccess = () => {
        const current = store.get(target.id);
        current.onsuccess = () => {
          if (signal.aborted || (count.result >= 16 && current.result === undefined))
            transaction.abort();
          else {
            const { bearerToken: _bearer, tickets: _tickets, ...metadata } = target;
            store.put({ version: 1, ...metadata }, target.id);
          }
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(new RelayError("UNAVAILABLE"));
    });
    // Match Cafe browser policy: credentials survive reload only in this tab.
    // IndexedDB retains metadata and a nonextractable wrapping key, no bearer,
    // device key, reconnect capability, or encrypted credential payload.
    requireRelay(!signal.aborted, "UNAVAILABLE");
    sessionStorage.setItem(
      sessionKey(target.id),
      decodeUtf8(
        canonicalBytes(
          { version: 1, iv: opaque(iv), ciphertext: opaque(new Uint8Array(ciphertext)) },
          24_000,
        ),
      ),
    );
  } catch {
    throw new RelayError("UNAVAILABLE");
  } finally {
    database.close();
  }
}
export async function loadRelayTarget(
  id: string,
): Promise<{ target: SavedRelayTarget; identity: RelayIdentity }> {
  unopaque(id, 32);
  const database = await open();
  try {
    const raw = sessionStorage.getItem(sessionKey(id));
    requireRelay(raw !== null && raw.length <= 24_000, "AUTH_REQUIRED");
    const stored = readCanonical(SessionRecord, utf8.encode(raw), 24_000);
    const iv = unopaque(stored.iv, 12),
      ciphertext = unopaqueBounded(stored.ciphertext, maximum + 16);
    const key = await wrappingKey(database);
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.slice(), additionalData: additionalData(id) },
      key,
      ciphertext.slice(),
    );
    const payload = readCanonical(Payload, new Uint8Array(bytes), maximum);
    requireRelay(payload.target.id === id);
    return {
      target: payload.target,
      identity: restoreIdentity(unopaqueBounded(payload.devicePrivateKey, 128)),
    };
  } catch {
    throw new RelayError("AUTH_REQUIRED");
  } finally {
    database.close();
  }
}
