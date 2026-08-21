export interface ProtocolMethodEntry {
  readonly method: string;
  readonly paramsType?: string;
  readonly paramsOptional?: boolean;
}

/**
 * Parse the generated TypeScript request union published by Codex app-server.
 *
 * Codex 0.149 changed `account/usage/read` from a required `params: undefined`
 * field to `params?: GetAccountTokenUsageParams | undefined`. Treating the
 * question mark as cosmetic silently removes the entire RPC from Cafe's
 * generated client, so optionality is retained as protocol metadata and the
 * redundant TypeScript `undefined` union member is removed from the schema
 * name before resolution.
 */
export function parseRequestEntries(fileContents: string): ReadonlyArray<ProtocolMethodEntry> {
  const entryPattern =
    /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params\s*(\?)?\s*:\s*([^,}]+)/g;
  const entries: Array<ProtocolMethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    const rawParamsType = match[3]!.trim();
    const paramsTypeMembers = rawParamsType
      .split("|")
      .map((member) => member.trim())
      .filter((member) => member !== "undefined");
    const paramsOptional =
      match[2] === "?" || paramsTypeMembers.length !== rawParamsType.split("|").length;
    const paramsType = paramsTypeMembers.length === 0 ? "undefined" : paramsTypeMembers.join(" | ");

    entries.push({
      method: match[1]!,
      paramsType,
      ...(paramsOptional && paramsType !== "undefined" ? { paramsOptional: true } : {}),
    });
  }
  return entries;
}

export function parseNotificationEntries(fileContents: string): ReadonlyArray<ProtocolMethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<ProtocolMethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}
