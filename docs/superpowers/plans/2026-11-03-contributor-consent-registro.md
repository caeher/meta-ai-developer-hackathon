# Contributor consent al registro Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Mover la confirmacion 18+ y terminos Contributor del chat por mensaje al registro como dato del usuario.

**Architecture:** users.contributor_consent_at como fuente de verdad con backfill para actuales; registro bloqueante; POST /runs deriva de sesion; editor sin casilla.

**Tech Stack:** Next.js App Router + TypeScript estricto, Drizzle + PostgreSQL, Zod, Radix Themes/Primitives, Vitest + Playwright.

**Spec:** docs/superpowers/specs/2026-11-03-contributor-consent-registro-design.md

## Global Constraints

- Node 24 en todos los proyectos (engines.node >=24 <25); 
pm ci con lockfile versionado.
- Espanol en docs/UI, identificadores/codigo/eventos en ingles.
- Validacion Zod en fronteras; userId solo de sesion PostgreSQL, nunca de body/query/prompt.
- Migraciones SQL aditivas auditables + down; no montar socket Docker ni secretos en cliente.
- SANDBOX_DRIVER=disabled, RUNS_ENABLED=false, PREVIEW_GATEWAY_ENABLED=false, PUBLISHING_ENABLED=false por defecto.
- Sin *.localhost TLS publico ni VPS; Compose local es el unico entorno interno.
- No guardar clave/ID completo, correos o .env en diff/logs/fixtures.

## Review Focus

- Cliente viejo que aun envia contributorConsent:true/false en body de runs: debe encolar igual si el usuario tiene consent (ignorar campo). Test en Task 4.
- Usuario con contributor_consent_at IS NULL intenta POST /runs: debe recibir 403 contributor_consent_required, no crear run/reserva. Test en Task 4.
- Re-registro del mismo email no verificado sin y con casilla: sin casilla no reenvia ni eleva; con casilla fija consent_at y reenvia verificacion. Test en Task 2.
- Usuario borrado (deleted_at NOT NULL) con backfill: no debe recibir consent_at. Test en Task 1.
- Enqueue concurrente / doble con idempotency cuando falta consent: segundo intento no debe crear duplicado ni reserva. Test en Task 4.

---

### Task 1: Columna users + migracion con backfill adulto

**Files:**
- Modify: packages/db/src/schema/index.ts
- Create: packages/db/migrations/0015_user_contributor_consent.sql
- Create: packages/db/migrations/0015_user_contributor_consent_down.sql
- Test: 	ests/unit/user-consent-migration.test.ts (o extender suite auth existente si ya cubre schema)

**Interfaces:**
- Consumes: tabla users actual (id, userId, email, passwordHash, emailVerifiedAt, deletedAt).
- Produces: users.contributor_consent_at: timestamptz | null + migracion up/down para Tasks 2 y 4.

- [ ] **Step 1: Escribir test fallido de schema/migracion**
`	s
// tests/unit/user-consent-migration.test.ts
// - schema expone contributor_consent_at (nullable)
// - SQL up contiene ADD COLUMN + UPDATE ... WHERE deleted_at IS NULL
// - SQL down contiene DROP COLUMN
`
- [ ] **Step 2: Ejecutar y ver fallar**
Run: 
pm test -- tests/unit/user-consent-migration.test.ts
Expected: FAIL (columna/SQL no existen)
- [ ] **Step 3: Implementar contributorConsentAt en Drizzle users**
Firma: contributorConsentAt: timestamp(contributor_consent_at, { withTimezone: true }) nullable sin default. Archivo packages/db/src/schema/index.ts.
- [ ] **Step 4: Crear migracion 0015 up/down**
Up: ALTER TABLE users ADD COLUMN contributor_consent_at timestamptz; UPDATE users SET contributor_consent_at = now() WHERE deleted_at IS NULL AND contributor_consent_at IS NULL;
Down: ALTER TABLE users DROP COLUMN contributor_consent_at;
- [ ] **Step 5: Verificar**
Run: 
pm test -- tests/unit/user-consent-migration.test.ts
Expected: PASS. Luego 
pm run typecheck solo para packages/db.
- [ ] **Step 6: Commit**
`ash
git add packages/db/src/schema/index.ts packages/db/migrations/0015_* tests/unit/user-consent-migration.test.ts
git commit -m 'feat(auth): add users.contributor_consent_at with adult backfill'
`

### Task 2: Registro bloqueante en API

**Files:**
- Modify: pps/web/server/auth/service.ts
- Test: 	ests/unit/auth-register-consent.test.ts (nuevo o extender 	ests/unit/auth*.test.ts si existe)

**Interfaces:**
- Consumes: users.contributor_consent_at de Task 1.
- Produces: POST /api/auth/register exige consent; indUser* devuelven contributor_consent_at.

- [ ] **Step 1: Escribir tests fallidos**
`	s
// - POST register sin contributorConsent -> 400 contributor_consent_required, no crea usuario ni envia correo
// - POST register con contributorConsent:true -> 202, usuario con consent_at no nulo
// - Re-registro email existente con NULL: sin casilla no fija; con casilla fija consent_at y reenvia
// - Review Focus: re-registro con/sin casilla
`
- [ ] **Step 2: Ejecutar y ver fallar**
Run: 
pm test -- tests/unit/auth-register-consent.test.ts
Expected: FAIL
- [ ] **Step 3: Implementar egisterSchema = z.object({ email, password, contributorConsent: z.literal(true) }).strict()**
En createAuthHandlers.register: parsear, mapear contributorConsentRequired a 400 contributor_consent_required via piErrorResponse o respuesta explicita; insert users { ..., contributorConsentAt: new Date() }; si onConflictDoNothing y usuario existente con consent_at NULL y body true -> update SET consent_at=now() antes de reenviar verificacion.
- [ ] **Step 4: Verificar**
Run: 
pm test -- tests/unit/auth-register-consent.test.ts
Expected: PASS
- [ ] **Step 5: Commit**
`ash
git add apps/web/server/auth/service.ts tests/unit/auth-register-consent.test.ts
git commit -m 'feat(auth): require contributor consent at registration'
`

### Task 3: Casilla en UI de registro

**Files:**
- Modify: pps/web/components/auth/AuthForm.tsx
- Test: 	ests/editor.test.ts o nuevo 	ests/unit/auth-form-consent.test.ts (segun harness existente: render + body enviado)

**Interfaces:**
- Consumes: contrato POST /api/auth/register { email, password, contributorConsent:true } de Task 2.
- Produces: formulario register bloquea submit sin marcar; envia contributorConsent:true.

- [ ] **Step 1: Escribir test fallido**
`	s
// - modo register sin marcar -> boton/submit bloqueado y fetch no llamado
// - modo register marcado -> fetch body contiene contributorConsent:true
// - modo login no muestra casilla
`
- [ ] **Step 2: Ejecutar y ver fallar**
Run: 
pm test -- tests/unit/auth-form-consent.test.ts
Expected: FAIL
- [ ] **Step 3: Implementar Checkbox Radix requerido en AuthForm solo mode===register**
Texto ES identico al actual del editor: Confirmo que tengo 18 anos o mas y acepto los terminos de Meta Contributor: el proveedor puede usar las entradas para entrenamiento. No incluir datos personales, secretos ni informacion confidencial. + useState + disabled={busy || (register && !consent)}, incluir contributorConsent:true en body.
- [ ] **Step 4: Verificar**
Run: 
pm test -- tests/unit/auth-form-consent.test.ts
Expected: PASS + 
pm run lint
- [ ] **Step 5: Commit**
`ash
git add apps/web/components/auth/AuthForm.tsx tests/unit/auth-form-consent.test.ts
git commit -m 'feat(auth): add contributor consent checkbox to sign-up'
`

### Task 4: Runs deriva consent de usuario (server + contratos)

**Files:**
- Modify: packages/contracts/src/runs.ts
- Modify: pps/web/server/projects/run-handlers.ts
- Modify: packages/db/src/repositories/index.ts (enqueueRunInputSchema + enqueueRun)
- Modify: pps/web/hooks/use-run-events.ts (mensaje 403 + dejar de exigir campo)
- Test: 	ests/unit/run-handlers.test.ts (actualizar), 	ests/integration/orchestrator.test.ts (usuarios con consent)

**Interfaces:**
- Consumes: users.contributor_consent_at (Tasks 1-2), VerifiedIdentityContext.
- Produces: enqueueRun siempre crea uns.contributorConsent:true derivado; POST devuelve 403 contributor_consent_required si NULL.

- [ ] **Step 1: Escribir tests fallidos**
`	s
// - POST sin campo body pero usuario con consent -> 202/200 (compat cliente viejo)
// - POST con usuario sin consent -> 403 contributor_consent_required, sin run ni reserva (Review Focus)
// - enqueueRun directo sin consent en users -> lanza / no crea (mapear a 403 en handler)
// - doble enqueue idempotente sin consent no duplica
`
- [ ] **Step 2: Ejecutar y ver fallar**
Run: 
pm test -- tests/unit/run-handlers.test.ts
Expected: FAIL en nuevos casos
- [ ] **Step 3: Implementar**
EnqueueRunRequestSchema: contributorConsent: z.literal(true).optional() marcado @deprecated (aceptar e ignorar). un-handlers.POST: tras get project, lookup users.contributor_consent_at por identity.userId; si NULL -> 403; llamar enqueueRun sin pasar consent de body (o 	rue derivado). epositories.enqueueRun: dentro de tx leer users por ownerUserId FOR UPDATE, exigir consent_at NOT NULL (throw Error(contributor_consent_required)), insertar uns { contributorConsent:true } y evento un.queued { contributorConsent:true }. use-run-events: enqueueProjectRun(projectId,messageRequestId,idempotencyKey) sin campo; unErrorMessage mapea contributor_consent_required a Tu cuenta no registra la confirmacion de mayoria de edad y terminos. Vuelve a registrarte aceptandola.; mantener lectura de code tanto 400 como 403.
- [ ] **Step 4: Verificar**
Run: 
pm test -- tests/unit/run-handlers.test.ts tests/unit/run-events-handler.test.ts
Expected: PASS. Luego 
pm run test:integration (requiere Postgres/Redis/Silo locales).
- [ ] **Step 5: Commit**
`ash
git add packages/contracts/src/runs.ts apps/web/server/projects/run-handlers.ts packages/db/src/repositories/index.ts apps/web/hooks/use-run-events.ts tests/unit/run-handlers.test.ts
git commit -m 'feat(runs): derive contributor consent from user session'
`

### Task 5: Editor sin casilla por mensaje

**Files:**
- Modify: pps/web/components/editor/EditorShell.tsx
- Modify: 	ests/e2e/editor-fixture.tsx
- Modify: 	ests/editor.test.ts

**Interfaces:**
- Consumes: enqueueProjectRun sin consent (Task 4).
- Produces: composer sin gating de consent; texto estatico no bloqueante.

- [ ] **Step 1: Escribir/actualizar tests fallidos**
`	s
// - send/retry sin consent state previo igual encola (mock fetch runs 200)
// - fixture E2E ya no exige contributorConsent en body
// - UI no contiene checkbox #editor-contributor-consent pero si aviso estatico sin datos personales
`
- [ ] **Step 2: Ejecutar y ver fallar**
Run: 
pm test -- tests/editor.test.ts
Expected: FAIL (aun existe gating)
- [ ] **Step 3: Implementar en EditorShell**
Eliminar useState contributorConsent, todos if (!contributorConsent) y disabled={... !contributorConsent}, eliminar <label consent><Checkbox...>, anadir <Text size=1 color=gray>No incluir datos personales, secretos ni informacion confidencial. Al ejecutar aceptaste los terminos Contributor y la mayoria de edad en el registro.</Text>. Mantener resto de disabled por ctive/working/hydrating.
- [ ] **Step 4: Actualizar fixture y tests**
editor-fixture.tsx: aceptar body sin campo (solo validar messageRequestId ligado); mantener rama contributor_consent_required solo para usuarios sin consent (simular 403). editor.test.ts: enviar body sin contributorConsent.
- [ ] **Step 5: Verificar**
Run: 
pm test -- tests/editor.test.ts
Expected: PASS + 
pm run lint
- [ ] **Step 6: Commit**
`ash
git add apps/web/components/editor/EditorShell.tsx tests/e2e/editor-fixture.tsx tests/editor.test.ts
git commit -m 'feat(editor): remove per-message contributor consent gate'
`

### Task 6: Docs, limpieza y verificacion final

**Files:**
- Modify: docs/authentication.md
- Modify: packages/db/migrations/meta/_journal.json si drizzle-kit lo exige (o documentar generacion manual)
- Test: suites existentes (	ests/integration/orchestrator*.test.ts crear usuarios con contributor_consent_at)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: docs y suites en verde; rama lista para revision.

- [ ] **Step 1: Actualizar docs y fixtures restantes**
docs/authentication.md: flujo sign-up exige 18+ y Contributor, users.contributor_consent_at, backfill adultos, runs deriva de sesion. Revisar orchestrator.test.ts:112,219,281 y orchestrator-assets para crear usuarios con consent (si usan factories sin columna, anadirla).
- [ ] **Step 2: Ejecutar verificacion completa aplicable**
Run: 
pm run lint
Run: 
pm run typecheck
Run: 
pm test
Run: 
pm run test:integration (requiere infra:up + db:migrate)
Expected: PASS en las cuatro; anotar skips preexistentes (54 aprox) sin ocultar fallos.
- [ ] **Step 3: Commit**
`ash
git add docs/authentication.md tests/integration/orchestrator.test.ts tests/integration/orchestrator-assets.test.ts
git commit -m 'docs: contributor consent moved to registration'
`

## Self-Review (chequeo del autor del plan)

1. Cobertura: registro (T2-T3), DB (T1), runs server (T4), editor (T5), docs/verificacion (T6). Sin huecos.
2. Pasos: cada paso escribe una sola cosa razonable (test con asserts exactos, firma exacta, comando con salida esperada).
3. Tipos: contributor_consent_at: Date | null consistente en schema/service/repos; EnqueueRunRequest.contributorConsent? opcional en contrato y handler; enqueueProjectRun(projectId,messageRequestId,idempotencyKey) sin cuarto param en hook y editor.
4. Review Focus: 5 lineas arriba, cada una con test anadido a su tarea duena (T4 x3, T2 x1, T1 x1).
5. Proporcion: plan mas corto que el codigo que describe; sin cuerpos de funciones, solo firmas y asserts.

