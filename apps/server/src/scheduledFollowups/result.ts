// Keep server settlement and renderer presentation on one strict bounded
// decoder. The server still supplies and verifies the exact occurrence ID;
// display stripping is never an authorization path.
export {
  parseScheduledFollowupResult,
  type ScheduledFollowupResult,
} from "@cafecode/shared/scheduledFollowupResult";
