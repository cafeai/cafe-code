import { expect, it } from "vitest";
import { parseSecretRequest } from "./runnerEntry.ts";

const reference = "[CAFE_SECRET_0123456789abcdef0123456789abcdef]";
it("admits structured env/stdin and file content requests without putting references in argv", () => {
  expect(
    parseSecretRequest(
      JSON.stringify({
        operation: "run",
        argv: ["node", "script.mjs"],
        env: { KEY: reference },
        stdin: reference,
      }),
    ),
  ).toMatchObject({ operation: "run", env: { KEY: reference } });
  expect(
    parseSecretRequest(
      JSON.stringify({
        operation: "write_file",
        path: "/workspace/.env",
        content: `KEY=${reference}`,
      }),
    ),
  ).toMatchObject({ operation: "write_file" });
});
it("rejects malformed requests and unqualified argument expansion before native acquisition", () => {
  for (const input of [
    { operation: "run", argv: [] },
    { operation: "run", argv: ["curl", reference] },
    { operation: "run", argv: ["node"], cwd: "relative" },
    { operation: "run", argv: ["node"], env: { "BAD=NAME": "value" } },
    { operation: "run", argv: ["node"], detached: true },
    { operation: "write_file", path: "relative", content: "data" },
    { operation: "read_file", path: "/workspace/file", secretThreadId: "other" },
  ])
    expect(() => parseSecretRequest(JSON.stringify(input))).toThrow();
});
