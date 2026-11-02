import type { RunUsage } from "@meta-game/db";

export type WorkerRun = Readonly<{ id: string; projectId: string; idempotencyKey: string }>;
export type RunHandlerResult = Readonly<{ usage?: RunUsage }>;
export type RunHandler = (run: WorkerRun, context: { signal: AbortSignal }) => Promise<RunHandlerResult>;

export class RunProcessingError extends Error {
  public readonly code: string;

  constructor(
    code: string,
    public readonly retryable: boolean,
  ) {
    const safeCode = /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : "run_processing_failed";
    super(safeCode);
    this.code = safeCode;
    this.name = "RunProcessingError";
  }
}

/** Product handler stays closed until the separate orchestrator and sandbox issues are implemented. */
export const pendingOrchestratorHandler: RunHandler = async () => {
  throw new RunProcessingError("orchestrator_pending", false);
};
