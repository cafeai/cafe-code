import type { EnvironmentId } from "@cafecode/contracts";
import { fileRequest, readBounded } from "../../attachments/fileAttachments";
/** Capture the environment in every request; never replay viewer input. */
export async function workspaceRequest<T>(
  environmentId: EnvironmentId,
  input: object,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await fileRequest(environmentId, "/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    return JSON.parse(new TextDecoder().decode(await readBounded(response, 7 * 1024 * 1024))) as T;
  } catch {
    throw new Error(
      "The desktop operation did not complete. Check the connection and owner access.",
    );
  }
}
