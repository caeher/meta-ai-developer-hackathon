import { ProjectRunBusyError, type VerifiedIdentityContext } from "@meta-game/db";
import type { AgentSandbox } from "../agent/tools";
import {
  inspectPhaserTemplate,
  loadPhaserTemplate,
  materializePhaserTemplate,
  startPhaserTemplatePreview,
  type PhaserTemplateBundle,
} from "../agent/phaser-template";

type ProjectLookup = {
  get(identity: VerifiedIdentityContext, projectId: string): Promise<unknown | undefined>;
};

/**
 * Prepara la preview sin pasar por un run de IA: crea el sandbox del proyecto,
 * siembra la plantilla Phaser solo si el workspace esta vacio e inicia el
 * dev server fijo. Un workspace existente nunca se reescribe.
 */
export function createPreviewPreparationService(input: {
  projects: ProjectLookup;
  sandbox: AgentSandbox;
  isProjectBusy?(identity: VerifiedIdentityContext, projectId: string): Promise<boolean>;
  loadTemplate?: () => Promise<PhaserTemplateBundle>;
  signalTimeoutMs?: number;
}) {
  const loadTemplate = input.loadTemplate ?? loadPhaserTemplate;
  const inFlight = new Map<string, Promise<{ devServer: { status: string; port: number | null } } | undefined>>();

  async function prepareOnce(identity: VerifiedIdentityContext, projectId: string) {
    const project = await input.projects.get(identity, projectId);
    if (!project) return undefined;
    if (input.isProjectBusy && await input.isProjectBusy(identity, projectId)) throw new ProjectRunBusyError();

    const signal = AbortSignal.timeout(input.signalTimeoutMs ?? 9 * 60_000);
    const created = await input.sandbox.create(projectId, signal);
    if (created.state !== "ready") throw new Error("sandbox_not_ready");

    const template = await loadTemplate();
    const inspection = await inspectPhaserTemplate(input.sandbox, projectId, template, signal, false);
    if (inspection.status === "empty" || inspection.status === "resume") {
      await materializePhaserTemplate(input.sandbox, projectId, template, signal, async () => undefined);
    } else {
      // "ready" (plantilla sembrada) o "preserve" (workspace del usuario):
      // en ambos casos solo hay que (re)iniciar el dev server.
      await startPhaserTemplatePreview(input.sandbox, projectId, signal);
    }
    const state = await input.sandbox.inspect(projectId, signal);
    return { devServer: state.devServer };
  }

  return {
    prepare(identity: VerifiedIdentityContext, projectId: string) {
      const pending = inFlight.get(projectId);
      if (pending) return pending;
      const promise = prepareOnce(identity, projectId).finally(() => inFlight.delete(projectId));
      inFlight.set(projectId, promise);
      return promise;
    },
  };
}
