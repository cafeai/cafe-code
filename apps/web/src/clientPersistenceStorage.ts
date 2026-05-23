import {
  ClientSettingsSchema,
  EnvironmentId,
  type ClientSettings,
  type EnvironmentId as EnvironmentIdValue,
  type PersistedSavedEnvironmentRecord,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItemWithLegacy,
  setLocalStorageItemWithLegacy,
} from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "cafe-code:client-settings:v1";
export const LEGACY_CLIENT_SETTINGS_STORAGE_KEY = "cafecode:client-settings:v1";
export const SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY = "cafe-code:saved-environment-registry:v1";
export const LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY =
  "cafecode:saved-environment-registry:v1";
export const SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY =
  "cafe-code:saved-environment-session-secrets:v1";

const BrowserSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(
    Schema.Struct({
      alias: Schema.String,
      hostname: Schema.String,
      username: Schema.NullOr(Schema.String),
      port: Schema.NullOr(Schema.Number),
    }),
  ),
});
type BrowserSavedEnvironmentRecord = typeof BrowserSavedEnvironmentRecordSchema.Type;

const LegacyBrowserSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(
    Schema.Struct({
      alias: Schema.String,
      hostname: Schema.String,
      username: Schema.NullOr(Schema.String),
      port: Schema.NullOr(Schema.Number),
    }),
  ),
  bearerToken: Schema.optionalKey(Schema.String),
});
type LegacyBrowserSavedEnvironmentRecord = typeof LegacyBrowserSavedEnvironmentRecordSchema.Type;

const BrowserSavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(BrowserSavedEnvironmentRecordSchema)),
});
type BrowserSavedEnvironmentRegistryDocument =
  typeof BrowserSavedEnvironmentRegistryDocumentSchema.Type;

const LegacyBrowserSavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(LegacyBrowserSavedEnvironmentRecordSchema)),
});
type LegacyBrowserSavedEnvironmentRegistryDocument =
  typeof LegacyBrowserSavedEnvironmentRegistryDocumentSchema.Type;

const BrowserSavedEnvironmentSessionSecretsSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  secrets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
type BrowserSavedEnvironmentSessionSecrets =
  typeof BrowserSavedEnvironmentSessionSecretsSchema.Type;
const decodeBrowserSavedEnvironmentSessionSecrets = Schema.decodeUnknownSync(
  BrowserSavedEnvironmentSessionSecretsSchema,
);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  return record.desktopSsh ? { ...nextRecord, desktopSsh: record.desktopSsh } : nextRecord;
}

function sanitizeLegacySavedEnvironmentRecord(
  record: LegacyBrowserSavedEnvironmentRecord,
): BrowserSavedEnvironmentRecord {
  return toPersistedSavedEnvironmentRecord(record);
}

function sanitizeLegacySavedEnvironmentRegistryDocument(
  document: LegacyBrowserSavedEnvironmentRegistryDocument,
): BrowserSavedEnvironmentRegistryDocument {
  return {
    version: 1,
    records: (document.records ?? []).map((record) => sanitizeLegacySavedEnvironmentRecord(record)),
  };
}

function documentContainsLegacyBearerToken(
  document: LegacyBrowserSavedEnvironmentRegistryDocument,
): boolean {
  return (document.records ?? []).some((record) => record.bearerToken !== undefined);
}

function getBrowserSessionStorage(): Storage | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readBrowserSavedEnvironmentSessionSecrets(): BrowserSavedEnvironmentSessionSecrets {
  const storage = getBrowserSessionStorage();
  if (!storage) {
    return {};
  }

  const raw = storage.getItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    return decodeBrowserSavedEnvironmentSessionSecrets(JSON.parse(raw));
  } catch {
    storage.removeItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY);
    return {};
  }
}

function writeBrowserSavedEnvironmentSessionSecrets(
  document: BrowserSavedEnvironmentSessionSecrets,
): void {
  const storage = getBrowserSessionStorage();
  if (!storage) {
    return;
  }

  const secrets = document.secrets ?? {};
  if (Object.keys(secrets).length === 0) {
    storage.removeItem(SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY);
    return;
  }

  storage.setItem(
    SAVED_ENVIRONMENT_SESSION_SECRETS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      secrets,
    } satisfies BrowserSavedEnvironmentSessionSecrets),
  );
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    return getLocalStorageItemWithLegacy(
      CLIENT_SETTINGS_STORAGE_KEY,
      [LEGACY_CLIENT_SETTINGS_STORAGE_KEY],
      ClientSettingsSchema,
    );
  } catch {
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItemWithLegacy(
    CLIENT_SETTINGS_STORAGE_KEY,
    [LEGACY_CLIENT_SETTINGS_STORAGE_KEY],
    settings,
    ClientSettingsSchema,
  );
}

function readBrowserSavedEnvironmentRegistryDocument(): BrowserSavedEnvironmentRegistryDocument {
  if (!hasWindow()) {
    return {};
  }

  try {
    const parsed = getLocalStorageItemWithLegacy(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      [LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY],
      LegacyBrowserSavedEnvironmentRegistryDocumentSchema,
    );
    if (!parsed) {
      return {};
    }

    const sanitized = sanitizeLegacySavedEnvironmentRegistryDocument(parsed);
    if (documentContainsLegacyBearerToken(parsed)) {
      writeBrowserSavedEnvironmentRegistryDocument(sanitized);
    }
    return sanitized;
  } catch {
    return {};
  }
}

function writeBrowserSavedEnvironmentRegistryDocument(
  document: BrowserSavedEnvironmentRegistryDocument,
): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItemWithLegacy(
    SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
    [LEGACY_SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY],
    document,
    BrowserSavedEnvironmentRegistryDocumentSchema,
  );
}

function readBrowserSavedEnvironmentRecordsWithSecrets(): ReadonlyArray<BrowserSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRegistryDocument().records ?? [];
}

function writeBrowserSavedEnvironmentRecords(
  records: ReadonlyArray<BrowserSavedEnvironmentRecord>,
): void {
  writeBrowserSavedEnvironmentRegistryDocument({
    version: 1,
    records,
  });
}

export function readBrowserSavedEnvironmentRegistry(): ReadonlyArray<PersistedSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRecordsWithSecrets().map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeBrowserSavedEnvironmentRegistry(
  records: ReadonlyArray<PersistedSavedEnvironmentRecord>,
): void {
  writeBrowserSavedEnvironmentRecords(
    records.map((record) => toPersistedSavedEnvironmentRecord(record)),
  );
}

export function readBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
): string | null {
  readBrowserSavedEnvironmentRegistryDocument();
  return readBrowserSavedEnvironmentSessionSecrets().secrets?.[environmentId] ?? null;
}

export function writeBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
  secret: string,
): boolean {
  const found = (readBrowserSavedEnvironmentRegistryDocument().records ?? []).some(
    (record) => record.environmentId === environmentId,
  );
  if (!found) {
    return false;
  }

  const document = readBrowserSavedEnvironmentSessionSecrets();
  writeBrowserSavedEnvironmentSessionSecrets({
    version: document.version ?? 1,
    secrets: {
      ...document.secrets,
      [environmentId]: secret,
    },
  });
  return true;
}

export function removeBrowserSavedEnvironmentSecret(environmentId: EnvironmentIdValue): void {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  writeBrowserSavedEnvironmentRegistryDocument(document);

  const sessionDocument = readBrowserSavedEnvironmentSessionSecrets();
  const { [environmentId]: _removed, ...remainingSecrets } = sessionDocument.secrets ?? {};
  writeBrowserSavedEnvironmentSessionSecrets({
    version: sessionDocument.version ?? 1,
    secrets: remainingSecrets,
  });
}
