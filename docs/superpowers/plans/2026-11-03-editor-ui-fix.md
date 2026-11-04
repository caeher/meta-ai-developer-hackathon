# Editor UI Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Corregir altura de preview, overflow de pestañas, estado vacío, composer y botones mudos del editor (opción A).

**Architecture:** Solo CSS Modules del editor/preview + cambios menores en EditorShell.tsx (ejemplos, nota visible, rows). Sin contratos nuevos.

**Tech Stack:** Next.js, Radix Themes, CSS Modules, Playwright E2E existente.

**Spec:** docs/superpowers/specs/2026-11-03-editor-ui-fix-design.md

## Global Constraints
- Node 24, tokens Tokyo Night de apps/web/styles/tokens.css; sin hex arbitrarios nuevos.
- No cambiar flags (RUNS_ENABLED, PREVIEW_GATEWAY_ENABLED, PUBLISHING_ENABLED), contratos ni SSE.
- E2E existente `tests/e2e/editor-shell.spec.ts` debe seguir pasando: región preview con overflowY auto, tabs por rol, Publish/Share disabled sin publicación.

## Review Focus
- 390px: pane switch sigue ocultando el panel inactivo; sin overflow de página.
- Preview deshabilitada: estado "Deshabilitada", nunca "Conectando" infinito.
- Ejemplos del estado vacío solo rellenan el borrador; no envían ni encolan.
- Con run activo, ejemplos y composer permanecen deshabilitados igual que hoy.
- Tabs: las 8 pestañas accesibles por teclado/scroll sin scrollbar visible.

---

### Task 1: Preview a altura completa
**Files:** Modify: `apps/web/components/editor/EditorShell.module.css` (.previewPane), `apps/web/components/editor/PreviewFrame.module.css` (.preview height:100%)
- [x] CSS: previewPane display:grid; .preview height:100%.
- [x] Verificar E2E viewport tests + captura.

### Task 2: Toolbar sin overflow
**Files:** Modify: `EditorShell.module.css` (.chatToolbar,.progressTabs, botón opciones flex:none, scrollbar oculta)
- [x] CSS sin scrollbar visible, botón nunca cortado.

### Task 3: Estado vacío + composer + Publish/Share
**Files:** Modify: `apps/web/components/editor/EditorShell.tsx` (EXAMPLE_PROMPTS, nota visible, title, rows=2), `EditorShell.module.css` (.emptyExamples,.publishHint)
- [x] Ejemplos rellenan borrador vía setContent con mismo guard de run activo.
- [x] Nota visible solo si !publishingEnabled.
- [x] Verificar lint/typecheck/tests + captura 1440/390.
