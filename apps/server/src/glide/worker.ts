import { z } from "zod";
import { readGlideFrames, writeGlideFrame } from "./framing.ts";
import { createGlideKernel } from "./kernel.ts";
import { jsInputSchema } from "./protocol.ts";

const response = z
  .object({
    type: z.literal("rpc-result"),
    executionId: z.string(),
    id: z.number().int().positive(),
    result: z.unknown().optional(),
    error: z.string().max(2048).optional(),
  })
  .strict();
const execute = z
  .object({ type: z.literal("execute"), executionId: z.string(), code: jsInputSchema.shape.code })
  .strict();

export async function runGlideWorker(): Promise<void> {
  let executionId: string | undefined;
  let sequence = 0;
  let writes = Promise.resolve();
  const send = (value: unknown) => {
    writes = writes.then(() => writeGlideFrame(process.stdout, value));
    return writes;
  };
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const kernel = createGlideKernel(async (request) => {
    if (!executionId) throw new Error("No active Glide execution.");
    const id = ++sequence;
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    try {
      await send({ type: "rpc", executionId, id, request });
    } catch {
      pending.delete(id);
      throw new Error("Glide broker disconnected.");
    }
    return result;
  });
  try {
    for await (const message of readGlideFrames(process.stdin)) {
      const reply = response.safeParse(message);
      if (reply.success) {
        if (reply.data.executionId !== executionId)
          throw new Error("Glide execution identity mismatch.");
        const call = pending.get(reply.data.id);
        if (!call) throw new Error("Unknown Glide reply.");
        pending.delete(reply.data.id);
        if (reply.data.error !== undefined) call.reject(new Error(reply.data.error));
        else call.resolve(reply.data.result);
        continue;
      }
      const cell = execute.parse(message);
      if (executionId) throw new Error("Overlapping Glide cells.");
      executionId = cell.executionId;
      void kernel
        .execute(cell.code)
        .then(async (result) => {
          executionId = undefined;
          await send({ type: "result", executionId: cell.executionId, result });
        })
        .catch(() => process.exit(1));
    }
  } finally {
    for (const call of pending.values()) call.reject(new Error("Glide broker disconnected."));
    pending.clear();
  }
}

if (import.meta.main) {
  runGlideWorker().catch(() => {
    process.stderr.write("Glide worker stopped.\n");
    process.exitCode = 1;
  });
}
