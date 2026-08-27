import { describe, expect, it } from "vitest";

import {
  DICTATION_RPC_ERROR_MESSAGES,
  formatDictationRpcError,
  readDictationRpcErrorCode,
} from "./errors";

describe("dictation RPC error sanitization", () => {
  it.each(Object.entries(DICTATION_RPC_ERROR_MESSAGES))(
    "maps %s without rendering the received message or cause",
    (code, message) => {
      const leakedDetail = "sk-sensitive-provider-detail";
      const error = {
        code,
        message: leakedDetail,
        cause: { authorization: leakedDetail },
      };

      expect(readDictationRpcErrorCode(error)).toBe(code);
      expect(formatDictationRpcError(error)).toBe(message);
      expect(formatDictationRpcError(error)).not.toContain(leakedDetail);
    },
  );

  it.each([
    null,
    "transport failed",
    { code: "future_error", message: "unsafe provider detail" },
    { code: 401, message: "unsafe provider detail" },
  ])("rejects unknown or malformed RPC failures", (error) => {
    expect(readDictationRpcErrorCode(error)).toBeNull();
    expect(formatDictationRpcError(error)).toBeNull();
  });
});
