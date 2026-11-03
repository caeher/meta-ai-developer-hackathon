import type { CreateIssuePlanInput, CreateIssuePlanResult, IssueFileStatusSchema, IssuePlanKind } from "@meta-game/contracts";
import { CreateIssuePlanInputSchema, issuePlanDirectory } from "@meta-game/contracts";
import type { z } from "zod";

export type IssueFileStatus = z.infer<typeof IssueFileStatusSchema>;
export type IssuePlanFile = Readonly<{ path: string; content: string }>;

export function issueIdFor(index: number, slug: string): string {
  return `${String(index + 1).padStart(2, "0")}-${slug}`;
}

export function issueFilePath(kind: IssuePlanKind, id: string): string {
  return `${issuePlanDirectory(kind)}/${id}.md`;
}

/** Seccion especializada que todo Markdown de sprites / juego debe contener. */
export function specializedSection(kind: IssuePlanKind): string[] {
  if (kind === "sprites") {
    return [
      "## Como hacer los sprites (sub-agente de sprites)", "",
      "- [ ] 1. `generate_image`: un asset por personaje/objeto/fondo, prompt con estilo, vista, paleta y fondo plano removible; anota el `assetId` devuelto (nunca adivines IDs).",
      "- [ ] 2. `make_transparent` (corner-flood o color-key) solo si el fondo debe eliminarse; conserva el original.",
      "- [ ] 3. `inspect_asset` sobre cada PNG resultante: dimensiones, alpha y frames validos antes de empaquetar.",
      "- [ ] 4. `pack_spritesheet`: atlas Phaser 3.90 JSON Hash en orden row-major; anota `textureAssetId`/`atlasAssetId` y nombres de frame.",
      "- [ ] 5. `define_animation` por clip (idle/run/jump/attack) con frameNames exactos del atlas y fps; tiles con `create_tileset` y niveles con `create_tilemap` si aplica.",
      "- [ ] 6. Resultado obligatorio: lista assetId/atlasId/frames por sprite para que el plan de juego los consuma sin adivinar rutas.", "",
    ];
  }
  if (kind === "game") {
    return [
      "## Como implementar el juego (sub-agente de codigo)", "",
      "- [ ] 1. Lee el resumen de sprites previo (assetId, atlasId, frameNames, animaciones) y carga SOLO esos assets en el preload de Phaser 3.90.",
      "- [ ] 2. Implementa solo esta issue en `src/` con escenas, Arcade Physics, input teclado/touch y HUD segun el GameSpec.",
      "- [ ] 3. No regeneres sprites en esta fase: si falta un asset, reportalo en el Resultado en vez de inventar IDs o rutas.",
      "- [ ] 4. Verifica con las tools tipadas (`run_command` test/build, `start_dev_server`) y resume archivos cambiados.", "",
    ];
  }
  return [];
}

/** Pure builder: index + one Markdown file per issue. Sprites -> docs/issues/sprites/, juego -> docs/issues/game/, general -> docs/issues/. */
export function buildIssuePlanFiles(rawInput: CreateIssuePlanInput, planId: string): IssuePlanFile[] {
  const input = CreateIssuePlanInputSchema.parse(rawInput);
  const kind = input.kind ?? "general";
  const dir = issuePlanDirectory(kind);
  const idBySlug = new Map(input.issues.map((issue, index) => [issue.slug, issueIdFor(index, issue.slug)]));
  const issues = input.issues.map((issue) => {
    const id = idBySlug.get(issue.slug)!;
    return { id, slug: issue.slug, title: issue.title, path: `${dir}/${id}.md`, dependsOn: issue.dependsOn.map((s) => idBySlug.get(s)!), issue };
  });
  const phaseNote = kind === "sprites"
    ? "Fase sprites: este plan se ejecuta con sub-agentes de sprites (tools de assets) ANTES de planificar el codigo del juego."
    : kind === "game"
      ? "Fase juego: este plan consume el resumen de sprites ya producido y se ejecuta con sub-agentes de codigo."
      : "El agente principal ejecuta estas issues en orden de dependencias mediante sub-agentes. Un solo escritor por workspace: los sub-agentes corren de forma secuencial.";
  const index = [
    `# Plan: ${input.title}`, "", `Plan: ${planId}`, `Tipo: ${kind}`, "", phaseNote,
    "", "## Issues", "",
    ...issues.map(({ id, title, path, dependsOn }) => `- [${id}: ${title}](${path.replace(`${dir}/`, "")})${dependsOn.length ? ` - depende de ${dependsOn.join(", ")}` : ""}`),
    "",
  ].join("\n");
  const files: IssuePlanFile[] = [{ path: `${dir}/INDEX.md`, content: index }];
  for (const { id, title, path, dependsOn, issue } of issues) {
    files.push({
      path,
      content: [
        `# [${id}] ${title}`, "", `Plan: ${planId}`, `Tipo: ${kind}`, `Estado: pending`,
        `Depende de: ${dependsOn.length ? dependsOn.join(", ") : "ninguna"}`, "",
        "## Objetivo", "", issue.objective, "",
        ...specializedSection(kind),
        "## Tareas", "", ...issue.tasks.map((task) => `- [ ] ${task}`), "",
        "## Aceptacion", "", ...(issue.acceptance.length ? issue.acceptance.map((a) => `- [ ] ${a}`) : ["- [ ] La issue queda implementada y verificada en la preview."]), "",
        "## Resultado", "", "Pendiente.", "",
      ].join("\n"),
    });
  }
  return files;
}

export function issuePlanResult(rawInput: CreateIssuePlanInput, planId: string): CreateIssuePlanResult {
  const input = CreateIssuePlanInputSchema.parse(rawInput);
  const kind = input.kind ?? "general";
  const dir = issuePlanDirectory(kind);
  const idBySlug = new Map(input.issues.map((issue, index) => [issue.slug, issueIdFor(index, issue.slug)]));
  return {
    planId, title: input.title, kind, indexPath: `${dir}/INDEX.md` as CreateIssuePlanResult["indexPath"],
    issues: input.issues.map((issue) => {
      const id = idBySlug.get(issue.slug)!;
      return { id, title: issue.title, path: `${dir}/${id}.md` as const, kind, status: "pending" as const, dependsOn: issue.dependsOn.map((s) => idBySlug.get(s)!) };
    }),
  };
}

/** Replace the Estado line and the Resultado section; leave tasks/objective untouched. */
export function updateIssueFileStatus(content: string, status: IssueFileStatus, summary: string): string {
  const withStatus = /^Estado:.*$/m.test(content) ? content.replace(/^Estado:.*$/m, `Estado: ${status}`) : `Estado: ${status}
${content}`;
  const safe = summary.replace(/\s+/g, " ").slice(0, 600) || "Sin resumen.";
  if (/^## Resultado\s*$/m.test(withStatus)) {
    return withStatus.replace(/^## Resultado\s*$[\s\S]*$/m, `## Resultado

${safe}
`);
  }
  return `${withStatus.trimEnd()}

## Resultado

${safe}
`;
}
