import {
  appendClaimedRunAgentEvents,
  getClaimedRunAgentContext,
  persistClaimedRunPlan,
  type ClaimedRunAgentContext,
  type GameDatabase,
  type RunWorkerClaim,
} from "@meta-game/db";
import type { AgentRunEvent, MetaPlan } from "@meta-game/contracts";

export interface AgentRunStore {
  load(claim: RunWorkerClaim): Promise<ClaimedRunAgentContext>;
  append(claim: RunWorkerClaim, events: readonly AgentRunEvent[]): Promise<void>;
  persistPlan(claim: RunWorkerClaim, input: {
    plan: MetaPlan;
    model: string;
    responseId: string;
    requestId?: string;
    usage: { tokens: number; images: 0 };
  }): Promise<void>;
}

export function createPostgresAgentRunStore(database: GameDatabase): AgentRunStore {
  return {
    load: (claim) => getClaimedRunAgentContext(database, claim),
    append: (claim, events) => appendClaimedRunAgentEvents(database, claim, events),
    persistPlan: (claim, input) => persistClaimedRunPlan(database, claim, input),
  };
}
