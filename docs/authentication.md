# Autenticación propia

Forja autentica cuentas con correo y contraseña sin un servicio de identidad externo. La API y las páginas privadas validan la sesión contra PostgreSQL; `userId` se obtiene de la fila asociada a la sesión y nunca del body, la query, el prompt ni una cabecera del cliente.

## Flujos

- `/sign-up` crea una cuenta con correo normalizado y contraseña de al menos 12 caracteres. El acceso requiere verificar el correo.
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

## Correo

`Mailer` separa el envío del flujo de autenticación. `ConsoleMailer` está habilitado en `NODE_ENV=development` y muestra el enlace de un solo uso como cuerpo del correo local. En producción, registro y recuperación responden `503 email_delivery_unavailable` hasta configurar una implementación de entrega; no se marca una cuenta como verificada ni se simula un envío.

## Entorno local

`APP_ORIGIN`, `AUTH_ALLOWED_ORIGINS`, `AUTH_SECRET`, `SESSION_TTL_SECONDS` y `SESSION_ABSOLUTE_TTL_SECONDS` se documentan en `.env.example`. `AUTH_SECRET` solo protege los buckets de rate limit; las sesiones no son JWT, sino tokens aleatorios opacos validados por su hash en la base de datos. En desarrollo el valor placeholder activa una clave local fija para que los flujos funcionen sin configuración adicional.

Inicia los servicios locales, aplica `npm run db:migrate` y ejecuta `npm run dev`. Regístrate, copia del log local el enlace de verificación, verifica el correo e inicia sesión. La recuperación sigue el mismo flujo con el enlace que emite el mailer local.

## Verificación

Las pruebas unitarias cubren scrypt, tokens, rotación, vencimiento deslizante/absoluto, revocación, política de cookies, bloqueo progresivo, CSRF y acceso cruzado. Las pruebas de integración verifican ownership con PostgreSQL y los recursos privados; E2E usa fixtures de navegador. Los flujos locales de correo no acreditan un proveedor de correo de producción.
