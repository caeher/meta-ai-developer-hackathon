# Autenticación y ownership

## Configuración

La app usa `@clerk/nextjs` 7.9.23, fijado con versión exacta y compatible con Next.js 16.4.3. El SDK solo se activa cuando el servidor recibe una clave publicable con prefijo Clerk reconocido y una clave secreta correspondiente. Los valores `placeholder` de `.env.example` no lo activan.

Para una instancia de desarrollo local, configura manualmente `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL` y `CLERK_AUTHORIZED_PARTIES` en el entorno del proceso web. Los authorized parties son una lista de orígenes exactos separados por comas; se admite HTTP solo para loopback local. No copies la plantilla sobre un `.env.local` existente ni agregues claves a Git.

Sin credenciales Clerk reales, la página de inicio y `/api/health` siguen disponibles, `/sign-in` y `/sign-up` muestran que falta configuración, las páginas privadas redirigen al acceso y las APIs privadas responden `503 authentication_not_configured`. El modo sin credenciales no crea una sesión fixture ni simula el servicio.

## Sesiones, rutas y datos

- `apps/web/proxy.ts` integra `clerkMiddleware()` y usa `authorizedParties`. Solo `/`, `/api/health`, `/sign-in` y `/sign-up` son públicas. Páginas privadas requieren sesión; APIs privadas responden `401` si no hay sesión.
- Los flujos de Clerk usan rutas catch-all `/sign-in` y `/sign-up` y fuerzan el retorno a `/editor`, una ruta relativa fija que no acepta un destino arbitrario del cliente.
- `requireUser()` obtiene `userId` exclusivamente de `auth()` en el servidor y lo convierte al contexto de identidad verificada que esperan los repositorios. No se acepta `userId` en body, query o cabeceras.
- `requireProjectOwner()` usa `projects.get`, que filtra por el owner derivado del contexto y por el ID del recurso. El API devuelve `404` uniforme para un proyecto ausente o de otro usuario. `GET` omite los campos internos de ownership y usa `Cache-Control: private, no-store`.
- `PATCH /api/projects/[projectId]` comprueba `Origin` contra los orígenes autorizados, valida `Sec-Fetch-Site`, limita el body a 16 KiB y solo acepta `name`. Campos extra como `userId` se descartan por el schema Zod. El repositorio vuelve a comprobar ownership al mutar.
- Los módulos que acceden a Clerk, claves o DB están marcados como `server-only`. No se solicita ni almacena PII de perfil; el repositorio persiste solo el identificador opaco de Clerk cuando crea el primer recurso.

## Verificación

`npm test` ejecuta fixtures sintéticos para sesión ausente, identities A/B, lectura y mutación cruzadas, campos `userId` falsificados, CSRF/origen y errores sin detalles sensibles. `npm run test:integration` además prueba el filtro de owner de PostgreSQL cuando Postgres/S3 locales están arriba.

La comprobación de sign-in real, expiración de sesión y dos cuentas en una instancia Clerk requiere credenciales y usuarios de prueba del operador. No hay claves Clerk en este entorno, así que esa evidencia queda pendiente; no se cuentan los fixtures como prueba de la integración externa.

## Registro de verificación local (2 de noviembre de 2026)

En Node 24.22.1 se ejecutaron `npm test` (28 pasaron; 5 pruebas de integración omitidas por la suite unitaria), `npm run test:integration` (5 pasaron), `npm run lint`, `npm run typecheck` y `npm run build`; todos terminaron correctamente. La suite de integración creó y eliminó su base PostgreSQL y bucket S3 temporales.

El smoke de producción devolvió `200` para `/api/health` y `/sign-in`, `307` para `/editor` sin sesión, y `503 authentication_not_configured` para la API privada sin credenciales Clerk. La revisión de los chunks JavaScript no encontró valores con formato de clave secreta Clerk (`sk_test_`/`sk_live_`).

Esto verifica el comportamiento local fail-closed y los contratos con identidades sintéticas. Sigue pendiente usar una instancia Clerk real para validar sign-in/sign-out, expiración de sesión y lecturas/escrituras cruzadas entre dos cuentas; no se considera completada esa prueba externa.

## Continuación de la verificación (#4)

El 2 de noviembre de 2026 se volvió a comprobar la disponibilidad de la configuración sin leer ni registrar sus valores. El proceso no tiene las claves Clerk requeridas ni credenciales configuradas para dos cuentas de prueba. Por ello no se pudo ejecutar el recorrido E2E contra Clerk ni verificar la expiración y el acceso cruzado con sesiones reales. La issue permanece abierta; los fixtures locales no sustituyen esa evidencia.
