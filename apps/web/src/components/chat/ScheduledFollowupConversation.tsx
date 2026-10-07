import type { ScheduledFollowupId, ScheduledFollowupRecord } from "@cafecode/contracts";
import { memo, useCallback, useRef, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScheduledFollowupNotices } from "./ScheduledFollowupNotices";
import { ScheduledFollowups, type ScheduledFollowupsContext } from "./ScheduledFollowups";
import { readRetainedScheduledFollowupNotices } from "./scheduledFollowupsResource";
import { useScheduledFollowups } from "./useScheduledFollowups";

/** This is a live, bounded view of saved schedules, not assistant-message
 * parsing or a second scheduler. It stays mounted with the conversation even
 * when Tasks is closed; Tasks and this view share the same read resource. */
export const ScheduledFollowupConversation = memo(function ScheduledFollowupConversation({
  context,
}: {
  context: ScheduledFollowupsContext;
}) {
  return (
    <ConversationSchedules
      key={JSON.stringify([
        context.environmentId,
        context.threadId,
        context.modelSelection.instanceId,
      ])}
      context={context}
    />
  );
});

function ConversationSchedules({ context }: { context: ScheduledFollowupsContext }) {
  const { schedules, loading, error, refresh } = useScheduledFollowups(
    context.environmentId,
    context.threadId,
  );
  const [reviewId, setReviewId] = useState<ScheduledFollowupId | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Returning to a chat: until its first authoritative read lands, show the
  // last successful (instruction-free) rows instead of an empty tail that would
  // grow under the reader. They stay non-reviewable while loading.
  const displayedSchedules =
    loading && schedules.length === 0 && !error
      ? (readRetainedScheduledFollowupNotices(context.environmentId, context.threadId) ?? schedules)
      : schedules;
  const review = useCallback(
    (record: ScheduledFollowupRecord) => {
      if (record.threadId !== context.threadId || context.unavailable || error) return;
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Only the ID crosses into the review surface. The existing Tasks editor
      // resolves the saved definition and retains its account/revision fences.
      setReviewId(record.id);
      refresh();
    },
    [context.threadId, context.unavailable, error, refresh],
  );

  return (
    <>
      <ScheduledFollowupNotices
        context={context}
        schedules={displayedSchedules}
        loading={loading}
        error={error}
        onReview={review}
        onRefresh={refresh}
      />
      <Dialog
        open={reviewId !== null}
        onOpenChange={(open) => {
          if (!open) setReviewId(null);
        }}
      >
        <DialogPopup
          className="no-drag max-w-xl"
          finalFocus={() => (returnFocusRef.current?.isConnected ? returnFocusRef.current : false)}
        >
          <DialogHeader>
            <DialogTitle>Review scheduled follow-up</DialogTitle>
            <DialogDescription>
              Check the instructions, timing and paying account. Opening this review changes
              nothing; proposals still need your approval.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {reviewId ? (
              <ScheduledFollowups
                key={reviewId}
                context={context}
                initialReviewScheduleId={reviewId}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
