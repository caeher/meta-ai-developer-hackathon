import { describe, expect, it, vi } from "vitest";
import { removeProjectRunJobs } from "../apps/worker/src/queue";

describe("limpieza durable de jobs de proyecto", () => {
  it("elimina la generación registrada en PostgreSQL y omite jobs ya ausentes", async () => {
    const remove = vi.fn(async () => undefined);
    const lookup = vi.fn(async (jobId: string) => jobId === "run-run-a-2"
      ? { getState: async () => "failed", remove }
      : undefined);

    await removeProjectRunJobs({ getJob: lookup }, [
      { runId: "run-a", generation: 2 },
      { runId: "run-b", generation: 0 },
    ]);

    expect(lookup).toHaveBeenNthCalledWith(1, "run-run-a-2");
    expect(lookup).toHaveBeenNthCalledWith(2, "run-run-b-0");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("retiene el job y falla para reintentar si sigue activo", async () => {
    const remove = vi.fn(async () => undefined);
    const lookup = vi.fn(async () => ({ getState: async () => "active", remove }));

    await expect(removeProjectRunJobs({ getJob: lookup }, [{ runId: "run-a", generation: 0 }]))
      .rejects.toThrow("project_cleanup_job_active");
    expect(remove).not.toHaveBeenCalled();
  });
});
