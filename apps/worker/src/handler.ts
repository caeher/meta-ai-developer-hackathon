import type { RunUsage } from "@meta-game/db";
import type { RunWorkerClaim } from "@meta-game/db";

export type WorkerRun = Readonly<{ id: string; projectId: string; idempotencyKey: string }>;
export type RunHandlerResult = Readonly<{ usage?: RunUsage }>;
export type RunHandlerContext = Readonly<{
  signal: AbortSignal;
  claim: RunWorkerClaim;
  markVerifying(): Promise<void>;
}>;
export type RunHandler = (run: WorkerRun, context: RunHandlerContext) => Promise<RunHandlerResult>;

export class RunProcessingError extends Error {
  public readonly code: string;

  public readonly causeCode?: string;
  constructor(
    code: string,
    public readonly retryable: boolean,
    public readonly usage?: RunUsage,
    causeCode?: string,
  ) {
    const safeCode = /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : "run_processing_failed";
    super(safeCode);
    this.code = safeCode;
    this.name = "RunProcessingError";
    if (causeCode && /^[a-z][a-z0-9_]{0,99}$/.test(causeCode)) this.causeCode = causeCode;
  }
}

/** Product handler stays closed unless the operator enables the fully configured agent runtime. */
export const pendingOrchestratorHandler: RunHandler = async () => {
  throw new RunProcessingError("orchestrator_pending", false);
};
