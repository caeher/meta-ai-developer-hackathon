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
