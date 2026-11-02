import {
  appendClaimedRunAgentEvents,
  getClaimedRunAgentContext,
  getClaimedRunIdentity,
  persistClaimedRunPlan,
  reserveClaimedRunImage,
  type ClaimedRunAgentContext,
  type GameDatabase,
  type RunWorkerClaim,
  type VerifiedIdentityContext,
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
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
  reserveImage(claim: RunWorkerClaim, input: { requestKey: string; round: number; dailyImageLimit: number }): Promise<boolean>;
}

export function createPostgresAgentRunStore(database: GameDatabase): AgentRunStore {
  return {
    load: (claim) => getClaimedRunAgentContext(database, claim),
    append: (claim, events) => appendClaimedRunAgentEvents(database, claim, events),
    persistPlan: (claim, input) => persistClaimedRunPlan(database, claim, input),
    identity: (claim) => getClaimedRunIdentity(database, claim),
    reserveImage: (claim, input) => reserveClaimedRunImage(database, claim, input),
  };
}
