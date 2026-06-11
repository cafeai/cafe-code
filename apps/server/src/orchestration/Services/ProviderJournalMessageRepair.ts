import type {
  ProviderJournalMessageRepairInput,
  ProviderJournalMessageRepairResult,
  ProviderThreadAssistantMessagesRepairInput,
  ProviderThreadAssistantMessagesRepairResult,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderJournalMessageRepairShape {
  readonly repairAssistantMessage: (
    input: ProviderJournalMessageRepairInput,
  ) => Effect.Effect<ProviderJournalMessageRepairResult>;
  readonly repairThreadAssistantMessages: (
    input: ProviderThreadAssistantMessagesRepairInput,
  ) => Effect.Effect<ProviderThreadAssistantMessagesRepairResult>;
}

export class ProviderJournalMessageRepair extends Context.Service<
  ProviderJournalMessageRepair,
  ProviderJournalMessageRepairShape
>()("cafecode/orchestration/Services/ProviderJournalMessageRepair") {}
