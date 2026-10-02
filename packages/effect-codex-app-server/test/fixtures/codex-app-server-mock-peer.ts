let nextServerRequestId = 10_000;
let pendingSkillsListRequestId: number | string | null = null;
let pendingSkillsListCwd: string | null = null;
let pendingUserInputRequestId: number | null = null;

const fixtureRoot = process.env.CAFE_CODE_MOCK_PEER_ROOT;
// A command-launch fixture must never wait indefinitely for EOF. This deadline
// is a backstop for a broken parent/test cleanup path, not a provider timeout.
if (fixtureRoot) {
  setTimeout(() => process.exit(1), 30_000).unref();
}

const fixtureEnvironment = () => ({
  home: process.env.HOME === fixtureRoot,
  userProfile: process.env.USERPROFILE === fixtureRoot,
  homeDriveAndPath: `${process.env.HOMEDRIVE}${process.env.HOMEPATH}` === fixtureRoot,
  appData: process.env.APPDATA === fixtureRoot,
  localAppData: process.env.LOCALAPPDATA === fixtureRoot,
  codexHome: process.env.CODEX_HOME === fixtureRoot,
  codexSqliteHome: process.env.CODEX_SQLITE_HOME === fixtureRoot,
  temp:
    process.env.TEMP === fixtureRoot &&
    process.env.TMP === fixtureRoot &&
    process.env.TMPDIR === fixtureRoot,
  path: process.env.PATH === process.env.CAFE_CODE_MOCK_PEER_PATH,
  nodeHooksAbsent:
    !process.env.NODE_OPTIONS &&
    !process.env.NODE_PATH &&
    !process.env.NODE_EXTRA_CA_CERTS &&
    !process.env.NODE_V8_COVERAGE,
  syntheticUser:
    process.env.USERNAME === "cafe-fixture" &&
    process.env.USERDOMAIN === "cafe-fixture" &&
    process.env.LOGONSERVER === "cafe-fixture",
  providerCredentialsAbsent:
    !process.env.OPENAI_API_KEY &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CODEX_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN,
});

const writeMessage = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: number | string, result: unknown) => {
  writeMessage({ id, result });
};

const respondError = (id: number | string, code: number, message: string) => {
  writeMessage({
    id,
    error: {
      code,
      message,
    },
  });
};

const sendRequest = (method: string, params: unknown) => {
  const id = nextServerRequestId++;
  writeMessage({ id, method, params });
  return id;
};

const handleMethod = (message: Record<string, unknown>) => {
  const method = message.method;
  if (typeof method !== "string") {
    return;
  }

  switch (method) {
    case "initialize": {
      respond(message.id as number | string, {
        userAgent:
          process.argv[2] === "--echo-argv"
            ? JSON.stringify({ argv: process.argv.slice(3), environment: fixtureEnvironment() })
            : "mock-codex-app-server",
        codexHome: process.cwd(),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "darwin" ? "macos" : process.platform,
      });
      return;
    }
    case "initialized": {
      writeMessage({
        method: "item/agentMessage/delta",
        params: {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      return;
    }
    case "account/read": {
      respond(message.id as number | string, {
        account: {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      });
      return;
    }
    case "skills/list": {
      pendingSkillsListRequestId = message.id as number | string;
      const params = message.params as { readonly cwds?: ReadonlyArray<unknown> } | undefined;
      const firstCwd = params?.cwds?.[0];
      pendingSkillsListCwd = typeof firstCwd === "string" ? firstCwd : process.cwd();
      pendingUserInputRequestId = sendRequest("item/tool/requestUserInput", {
        isBlocking: true,
        itemId: "item-approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [
          {
            id: "approved",
            header: "Approve",
            question: "Continue with the mock skills request?",
            options: [
              {
                label: "yes",
                description: "Approve the request",
              },
            ],
          },
        ],
      });
      return;
    }
    default: {
      if (message.id !== undefined) {
        respondError(message.id as number | string, -32601, `Unhandled request: ${method}`);
      }
    }
  }
};

const handleResponse = (message: Record<string, unknown>) => {
  if (message.id !== pendingUserInputRequestId) {
    return;
  }

  pendingUserInputRequestId = null;

  respond(pendingSkillsListRequestId!, {
    data: [
      {
        cwd: pendingSkillsListCwd ?? process.cwd(),
        errors: [],
        skills: [],
      },
    ],
  });
  pendingSkillsListRequestId = null;
  pendingSkillsListCwd = null;
};

let remainder = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const message = JSON.parse(trimmed) as Record<string, unknown>;
    if ("method" in message) {
      handleMethod(message);
      continue;
    }
    if ("id" in message) {
      handleResponse(message);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
