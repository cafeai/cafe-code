import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ChatImages } from "./service.ts";

/** This subscriber never does image I/O on the provider ingestion path. */
export const ChatImagePublicationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const images = yield* ChatImages;
    const queue = yield* Queue.dropping<{ threadId: string; messageId: string }>(64);
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.message-sent" ||
          event.payload.role !== "assistant" ||
          event.payload.streaming
        )
          return Effect.void;
        return Queue.offer(queue, event.payload).pipe(Effect.asVoid);
      }),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const item = yield* Queue.take(queue);
          yield* images
            .publish(item.threadId, item.messageId)
            .pipe(Effect.catch(() => Effect.logWarning("chat image publication unavailable")));
        }),
      ),
    );
  }),
);
