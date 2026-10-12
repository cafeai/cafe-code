import { describe, expect, it } from "vitest";

import {
  DICTATION_RPC_ERROR_MESSAGES,
  formatDictationRpcError,
  formatDictationRpcErrorCode,
  readDictationRpcErrorCode,
} from "./errors";

describe("dictation RPC error sanitization", () => {
  it("formats an allowlisted code for the requested locale without receiving error text", () => {
    const error = {
      code: "upstream_auth_failed",
      message: "opaque provider detail",
      cause: { credential: "opaque test secret" },
    };
    expect(formatDictationRpcError(error, "en")).toBe(
      "OpenAI rejected the saved dictation credential or its Realtime transcription access.",
    );
    expect(formatDictationRpcError(error, "ko")).toBe(
      "OpenAI가 저장된 받아쓰기 인증 정보 또는 Realtime 전사 접근 권한을 거부했습니다.",
    );
    expect(formatDictationRpcErrorCode("upstream_auth_failed", "ko")).toBe(
      formatDictationRpcError(error, "ko"),
    );
    expect(error.message).toBe("opaque provider detail");
    expect(formatDictationRpcError(error, "ko")).not.toContain("opaque");
  });

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
