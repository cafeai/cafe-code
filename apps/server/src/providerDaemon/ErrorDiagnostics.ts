export interface ProviderDaemonErrorCauseDiagnostic {
  readonly tag: string;
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly sqlReasonTag?: string;
  readonly sqlOperation?: string;
  readonly sqliteCode?: string;
  readonly sqliteErrno?: number;
}

export interface ProviderDaemonErrorDiagnostics {
  readonly tag: string;
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly causeChain: ReadonlyArray<ProviderDaemonErrorCauseDiagnostic>;
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STACK_LENGTH = 16_000;
const MAX_CAUSE_DEPTH = 8;

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...<truncated>`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function diagnosticMessage(value: unknown, record: Record<string, unknown> | null): string {
  if (value instanceof Error) {
    return truncateText(value.message, MAX_MESSAGE_LENGTH);
  }
  const recordMessage = optionalString(record?.message);
  if (recordMessage !== undefined) {
    return truncateText(recordMessage, MAX_MESSAGE_LENGTH);
  }
  return truncateText(String(value), MAX_MESSAGE_LENGTH);
}

function diagnosticTag(value: unknown, record: Record<string, unknown> | null): string {
  const effectTag = optionalString(record?._tag);
  if (effectTag !== undefined) {
    return effectTag;
  }
  const name = optionalString(record?.name);
  if (name !== undefined) {
    return name;
  }
  if (value instanceof Error && value.name.length > 0) {
    return value.name;
  }
  if (record !== null) {
    return "Object";
  }
  return typeof value;
}

function diagnosticName(
  value: unknown,
  record: Record<string, unknown> | null,
): string | undefined {
  if (value instanceof Error && value.name.length > 0) {
    return value.name;
  }
  return optionalString(record?.name);
}

function diagnosticStack(
  value: unknown,
  record: Record<string, unknown> | null,
): string | undefined {
  const stack = value instanceof Error ? value.stack : optionalString(record?.stack);
  return stack === undefined ? undefined : truncateText(stack, MAX_STACK_LENGTH);
}

function sqlReason(record: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(record?.reason);
}

function sqliteCode(record: Record<string, unknown> | null): string | undefined {
  const code = optionalString(record?.code);
  if (code !== undefined) {
    return code;
  }
  const sqliteErrorCode = optionalString(record?.sqliteCode);
  return sqliteErrorCode;
}

function sqliteErrno(record: Record<string, unknown> | null): number | undefined {
  const errno = optionalNumber(record?.errno);
  if (errno !== undefined) {
    return errno;
  }
  return optionalNumber(record?.sqliteErrno);
}

function causeCandidates(
  value: unknown,
  record: Record<string, unknown> | null,
): ReadonlyArray<unknown> {
  const candidates: unknown[] = [];
  const cause = record?.cause;
  if (cause !== undefined) {
    candidates.push(cause);
  }

  const reason = sqlReason(record);
  if (reason !== null) {
    candidates.push(reason);
    if (reason.cause !== undefined) {
      candidates.push(reason.cause);
    }
  }

  return candidates.filter((candidate) => candidate !== value);
}

function causeDiagnostic(value: unknown): ProviderDaemonErrorCauseDiagnostic {
  const record = asRecord(value);
  const reason = sqlReason(record);
  const stack = diagnosticStack(value, record);
  const name = diagnosticName(value, record);
  const sqlReasonTag = optionalString(reason?._tag);
  const sqlOperation = optionalString(reason?.operation);
  const code = sqliteCode(record);
  const errno = sqliteErrno(record);

  return {
    tag: diagnosticTag(value, record),
    message: diagnosticMessage(value, record),
    ...(name === undefined ? {} : { name }),
    ...(stack === undefined ? {} : { stack }),
    ...(sqlReasonTag === undefined ? {} : { sqlReasonTag }),
    ...(sqlOperation === undefined ? {} : { sqlOperation }),
    ...(code === undefined ? {} : { sqliteCode: code }),
    ...(errno === undefined ? {} : { sqliteErrno: errno }),
  };
}

export function buildProviderDaemonErrorDiagnostics(
  error: unknown,
): ProviderDaemonErrorDiagnostics {
  const causeChain: ProviderDaemonErrorCauseDiagnostic[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [error];

  while (queue.length > 0 && causeChain.length < MAX_CAUSE_DEPTH) {
    const current = queue.shift();
    const record = asRecord(current);
    if (record !== null) {
      if (seen.has(record)) {
        continue;
      }
      seen.add(record);
    }

    causeChain.push(causeDiagnostic(current));
    for (const candidate of causeCandidates(current, record)) {
      queue.push(candidate);
    }
  }

  const primary = causeChain[0] ?? {
    tag: "ProviderDaemonError",
    message: "Unknown provider daemon error",
  };

  return {
    tag: primary.tag,
    message: primary.message,
    ...(primary.name === undefined ? {} : { name: primary.name }),
    ...(primary.stack === undefined ? {} : { stack: primary.stack }),
    causeChain,
  };
}

export function summarizeProviderDaemonError(error: unknown): string {
  const diagnostics = buildProviderDaemonErrorDiagnostics(error);
  const rootCause = diagnostics.causeChain.find(
    (entry) => entry.message !== diagnostics.message && entry.message.length > 0,
  );
  return rootCause === undefined
    ? diagnostics.message
    : `${diagnostics.message}; caused by ${rootCause.message}`;
}
