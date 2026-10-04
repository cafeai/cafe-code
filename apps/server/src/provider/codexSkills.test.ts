import { describe, expect, it } from "vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { publicCodexSkills, requestCodexSkills } from "./codexSkills.ts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderSkillsResult } from "@cafecode/contracts";
const decodeResult = Schema.decodeUnknownSync(ProviderSkillsResult);

const skill = (name: string, enabled = true): CodexSchema.V2SkillsListResponse__SkillMetadata => ({
  name,
  enabled,
  path: "/private/account/skills/secret/SKILL.md",
  description: "Useful skill",
  scope: "repo",
  interface: { displayName: "Safe display", iconSmall: "/private/icon" },
});
const response = (
  skills = [skill("review")],
  cwd = "/workspace",
): CodexSchema.V2SkillsListResponse => ({
  data: [{ cwd, skills, errors: [] }],
});
describe("path-free scoped Codex skill discovery", () => {
  it("issues only a fresh skills/list for the authorized cwd, never a paid or health request", async () => {
    const requests: unknown[] = [];
    const client = {
      request: (method: string, input: unknown) => {
        requests.push({ method, input });
        return Effect.succeed(response());
      },
    } as unknown as CodexClient.CodexAppServerClientShape;
    expect((await Effect.runPromise(requestCodexSkills(client, "/workspace"))).status).toBe(
      "available",
    );
    expect(requests).toEqual([
      { method: "skills/list", input: { cwds: ["/workspace"], forceReload: true } },
    ]);
  });

  it("has a path-free bounded transport schema even if a future caller supplies a legacy path", () => {
    const decoded = decodeResult({
      status: "available",
      skills: [{ name: "review", enabled: true, path: "/private/skill", prompt: "not public" }],
    });
    expect(decoded).toEqual({ status: "available", skills: [{ name: "review", enabled: true }] });
    expect(() =>
      decodeResult({
        status: "available",
        skills: [{ name: "bad\nname", enabled: true }],
      }),
    ).toThrow();
  });
  it("retains only native enabled name references and safe display metadata", () => {
    const result = publicCodexSkills(
      response([skill("review"), skill("hidden", false)]),
      "/workspace",
    );
    expect(result).toEqual({
      status: "available",
      skills: [
        {
          name: "review",
          enabled: true,
          scope: "repo",
          displayName: "Safe display",
          shortDescription: "Useful skill",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not flatten foreign cwd entries or accept ambiguous matching entries", () => {
    expect(publicCodexSkills(response(undefined, "/foreign"), "/workspace")).toEqual({
      status: "unavailable",
      skills: [],
    });
    expect(
      publicCodexSkills({ data: [...response().data, ...response().data] }, "/workspace").status,
    ).toBe("unavailable");
    expect(
      publicCodexSkills(
        { data: [...response().data, ...response([skill("foreign")], "/other").data] },
        "/workspace",
      ).skills.map((entry) => entry.name),
    ).toEqual(["review"]);
  });
  it("rejects reference injection, disabled and duplicate skills, bounds untrusted labels", () => {
    const result = publicCodexSkills(
      response([
        skill("review"),
        skill("review"),
        skill("bad name"),
        skill("bad\nignore"),
        skill("../../private"),
        {
          ...skill("safe"),
          description: "x".repeat(513),
          interface: { displayName: "fake\u202eline" },
        },
      ]),
      "/workspace",
    );
    expect(result.skills).toHaveLength(2);
    expect(result.skills[1]).toEqual({ name: "safe", scope: "repo", enabled: true });
    expect(publicCodexSkills(response([]), "/workspace")).toEqual({ status: "empty", skills: [] });
  });
  it("fails closed on bounded catalogue overflow and native partial failures without leaking errors", () => {
    expect(
      publicCodexSkills(
        response(Array.from({ length: 513 }, (_, index) => skill(`a${index}`))),
        "/workspace",
      ).status,
    ).toBe("unavailable");
    const failed = {
      data: [{ ...response().data[0]!, errors: [{ path: "/private/path", message: "secret" }] }],
    };
    expect(publicCodexSkills(failed, "/workspace")).toEqual({ status: "unavailable", skills: [] });
  });
});
