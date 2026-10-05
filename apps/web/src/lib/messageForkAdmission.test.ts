import { expect, it } from "vitest";
import { EnvironmentId, ThreadId } from "@cafecode/contracts";
import {
  claimMessageFork,
  messageForkAdmissionKey,
  useMessageForkAdmission,
} from "./messageForkAdmission";

it("keeps exact pending authority outside pane lifetime and fences stale releases", () => {
  const key = messageForkAdmissionKey(EnvironmentId.make("environment-a"), ThreadId.make("chat"));
  const other = messageForkAdmissionKey(EnvironmentId.make("environment-b"), ThreadId.make("chat"));
  const release = claimMessageFork(key)!;
  const releaseOther = claimMessageFork(other)!;
  expect(useMessageForkAdmission.getState().has(key)).toBe(true);
  expect(claimMessageFork(key)).toBeNull();
  release();
  const releaseNext = claimMessageFork(key)!;
  release();
  expect(claimMessageFork(key)).toBeNull();
  releaseNext();
  releaseOther();
  expect(useMessageForkAdmission.getState().size).toBe(0);
});
