# Autenticación propia

Forja autentica cuentas con correo y contraseña sin un servicio de identidad externo. La API y las páginas privadas validan la sesión contra PostgreSQL; `userId` se obtiene de la fila asociada a la sesión y nunca del body, la query, el prompt ni una cabecera del cliente.

## Flujos

- `/sign-up` crea una cuenta con correo normalizado y contraseña de al menos 12 caracteres. El formulario exige marcar la confirmación de 18 años o más y los términos de Meta Contributor (`contributorConsent: true`); sin ella la API responde `400 contributor_consent_required` y no crea la cuenta ni envía correo. El acceso requiere verificar el correo.
- `/verify-email?token=...` envía el token por `POST /api/auth/verify-email`; no consume tokens durante un `GET` o prefetch.
- `/sign-in` inicia sesión y rota el token de sesión anterior.
- `/forgot-password` siempre responde con el mismo mensaje para que no revele si existe el correo. `/reset-password?token=...` consume un token de un solo uso y revoca todas las sesiones al cambiar la contraseña.
- El menú del header muestra iniciales y permite cerrar la sesión actual o todas las sesiones.

## Contratos y persistencia

- `hashPassword` usa scrypt con `N=32768`, `r=8`, `p=1`, salt aleatorio de 16 bytes y salida de 64 bytes. Se elige la implementación criptográfica nativa de Node para evitar módulos nativos incompatibles en Node 24/Windows.
- Los tokens de sesión, verificación y recuperación contienen 256 bits aleatorios. PostgreSQL guarda únicamente SHA-256; no se guarda el token enviado al navegador o al correo.
- `auth_sessions` guarda `created_at`, `last_seen_at`, expiración deslizante y expiración absoluta. Por defecto, la sesión dura siete días desde su último uso y nunca supera 30 días desde el inicio. La cookie `forja_session` es `HttpOnly`, `SameSite=Lax`, host-only y `Secure` en producción.
- `auth_tokens` guarda propósito, digest, vencimiento y consumo. Los tokens de verificación y recuperación vencen en 30 minutos; emitir uno nuevo invalida los anteriores del mismo propósito.
- `auth_rate_limits` guarda solo un HMAC-SHA-256 del correo normalizado y fallos. `AUTH_SECRET` protege los buckets contra búsquedas de correos; producción requiere un valor aleatorio de al menos 32 caracteres. Tras 5, 8 y 10 fallos aplica esperas progresivas de 1, 5 y 30 minutos; el contador se reinicia al pasar 15 minutos sin actividad. No se confía en `X-Forwarded-For` para identificar al cliente.
- Las mutaciones requieren `Origin` exacto de `AUTH_ALLOWED_ORIGINS` (o `APP_ORIGIN`) y rechazan `Sec-Fetch-Site` incompatible.
- La migración 0009 agrega las tablas propias y reemplaza la identidad externa. Las filas de usuarios y las relaciones internas por UUID se conservan; las cuentas anteriores sin correo/contraseña quedan sin iniciar sesión y requieren un procedimiento de reasignación si deben recuperarse.
- `users.contributor_consent_at` guarda cuándo la cuenta aceptó la mayoría de edad y los términos de Meta Contributor; es la fuente de verdad. La migración 0015 agrega la columna y marca con `now()` a las cuentas existentes no borradas. El registro fija el instante al crear la cuenta; re-registrar un correo no verificado con la casilla marcada lo fija antes de reenviar la verificación.
- `POST /api/projects/:id/runs` deriva el consentimiento de la sesión (`users.contributor_consent_at` por `userId`), nunca del body: el campo `contributorConsent` del contrato quedó deprecated y se ignora. Sin consentimiento responde `403 contributor_consent_required` sin crear run ni reserva; `runs.contributor_consent` se sigue guardando en `true` como historial.

## Correo

`Mailer` separa el envío del flujo de autenticación. `SmtpMailer` usa Nodemailer y acepta `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM`. Compose conecta web a Mailpit (`mailpit:1025`) sin TLS ni autenticación; el buzón web queda en `http://127.0.0.1:8025`. Para SMTP productivo configura un host TLS y credenciales en el entorno del servicio. Sin `SMTP_HOST`, desarrollo mantiene el fallback de consola; producción responde `503 email_delivery_unavailable`.

## Entorno local

`APP_ORIGIN`, `AUTH_ALLOWED_ORIGINS`, SMTP y los TTL de sesión se documentan en `.env.example` e `infra/env.example`. En local se aceptan tanto `http://localhost:3000` como `http://127.0.0.1:3000`, porque son orígenes distintos. `AUTH_SECRET` solo protege los buckets de rate limit; las sesiones no son JWT, sino tokens aleatorios opacos validados por su hash en la base de datos. En desarrollo el valor placeholder activa una clave local fija para que los flujos funcionen sin configuración adicional.

Inicia los servicios locales con `npm run infra:up -- --web`, aplica `npm run db:migrate` y registra una cuenta desde `http://127.0.0.1:3000/sign-up` o `http://localhost:3000/sign-up`. Abre Mailpit en `http://127.0.0.1:8025`, usa el enlace de verificación del mensaje e inicia sesión. La recuperación sigue el mismo flujo con el enlace enviado a Mailpit. `npm run dev` desde el host puede usar `SMTP_HOST=127.0.0.1`.

## Verificación

Las pruebas unitarias cubren scrypt, tokens, rotación, vencimiento deslizante/absoluto, revocación, política de cookies, bloqueo progresivo, CSRF, acceso cruzado, registro bloqueante sin casilla y consentimiento de runs derivado de la sesión (incluido el 403 sin crear run ni reserva). Las pruebas de integración verifican ownership con PostgreSQL y los recursos privados; E2E usa fixtures de navegador. Los flujos locales de correo no acreditan un proveedor de correo de producción.
