/** Synthetic Codex ChatGPT auth.json contents; never real credentials. */
const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

export const codexLoginFixture = (input: {
  readonly subject?: string;
  readonly accountId?: string;
  readonly refreshToken: string;
  readonly lastRefresh: string;
}) =>
  `${JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ sub: input.subject ?? "user-1" }),
      access_token: jwt({ sub: input.subject ?? "user-1" }),
      refresh_token: input.refreshToken,
      account_id: input.accountId ?? "account-1",
    },
    last_refresh: input.lastRefresh,
  })}\n`;
