import * as Schema from "effect/Schema";

import { assert, it } from "@effect/vitest";

import * as CodexSchema from "./schema.ts";

it("encodes the Codex 0.147 section filter and provider-private thread move", () => {
  assert.deepEqual(
    Schema.encodeSync(CodexSchema.V2ThreadListParams)({
      sectionId: "0199f60f-45af-7000-8000-000000000001",
      sortKey: "section_position",
    }),
    {
      sectionId: "0199f60f-45af-7000-8000-000000000001",
      sortKey: "section_position",
    },
  );
  assert.deepEqual(
    Schema.encodeSync(CodexSchema.V2ThreadSectionMoveParams)({
      threadId: "0199f60f-45af-7000-8000-000000000002",
      sectionId: "0199f60f-45af-7000-8000-000000000001",
      beforeThreadId: null,
    }),
    {
      threadId: "0199f60f-45af-7000-8000-000000000002",
      sectionId: "0199f60f-45af-7000-8000-000000000001",
      beforeThreadId: null,
    },
  );
});

it("decodes the Codex 0.147 nonblocking user-input request metadata", () => {
  const decoded = Schema.decodeUnknownSync(CodexSchema.ToolRequestUserInputParams)({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    questions: [
      {
        id: "choice",
        header: "Choice",
        question: "Which path should be used?",
        options: [
          {
            label: "Default",
            description: "Continue with the recommended path.",
          },
        ],
      },
    ],
    isBlocking: false,
    autoResolutionMs: null,
  });

  assert.equal(decoded.isBlocking, false);
  assert.equal(decoded.autoResolutionMs, null);
});
