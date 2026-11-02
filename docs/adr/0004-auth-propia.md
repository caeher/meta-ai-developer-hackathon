# ADR 0004: Autenticación propia

- Estado: aceptado
- Fecha: 2026-11-02
- Issue: #29 (reemplaza el alcance de autenticación de #4)

## Contexto

El dueño del proyecto decidió retirar Clerk (integrado por #4) y controlar localmente las cuentas. El producto necesita registro, inicio/cierre de sesión, recuperación, verificación de correo y una identidad estable para ownership de proyectos, sandboxes, previews, cuotas y grants.

## Decisión

- La app administra cuentas `email + password`; los correos se normalizan y son únicos. El acceso solo se habilita tras verificar el correo.
- Se usa scrypt de Node 24 (`N=32768`, `r=8`, `p=1`, salt 16 bytes, resultado 64 bytes) para evitar una dependencia nativa de terceros en Windows/Node 24.
- Los tokens opacos de 256 bits solo se entregan por cookie o correo. La DB conserva SHA-256, vencimiento, consumo y revocación, nunca el token original.
- La cookie `forja_session` usa `HttpOnly`, `SameSite=Lax`, `Path=/`, sin `Domain`, y `Secure` en producción. La sesión se extiende hasta 7 días de inactividad, con máximo absoluto de 30 días. Un nuevo login rota la sesión presentada; cierre local revoca una y cierre global revoca todas.
- El servidor verifica cada sesión antes de crear `VerifiedIdentityContext`. La app mantiene los UUID internos y las FK de ownership existentes; el identificador de autenticación es propio y aleatorio.
- Las mutaciones requieren `Origin` autorizado. Los límites y bloqueos progresivos se guardan en Postgres usando HMAC-SHA-256 del correo con `AUTH_SECRET`, con 1 minuto desde el quinto fallo, 5 minutos desde el octavo y 30 minutos desde el décimo. En producción `AUTH_SECRET` debe tener al menos 32 caracteres aleatorios.
- Los tokens de verificación y reset son de un uso y vencen a los 30 minutos. Reset revoca todas las sesiones.
- `Mailer` define la interfaz de correo. En desarrollo `ConsoleMailer` imprime el enlace como mensaje local; en producción los flujos que requieren correo fallan cerrados hasta conectar un proveedor real.

## Migración y recuperación

La migración 0009 conserva filas de usuarios y referencias UUID a proyectos, mensajes, assets, runs, versiones, sandboxes, publicaciones y cuotas; emite IDs locales nuevos y elimina la columna del proveedor anterior. Como el esquema previo no guardaba correos ni credenciales propias, esas filas no se pueden vincular automáticamente con una cuenta recién registrada. Si hay datos que recuperar, el operador debe validar titularidad y reasignar las FK mediante un proceso de soporte auditado antes de permitir acceso.

Para revertir el despliegue hay que restaurar un backup previo a 0009 y volver a la versión de aplicación anterior. No es seguro intentar convertir contraseñas scrypt o sesiones locales en credenciales de un proveedor externo.

## Consecuencias

La autenticación y sus dependencias funcionan localmente con Postgres. La disponibilidad de email productivo queda pendiente de configurar un `Mailer`; el resto del producto no debe habilitar flujos de alta/recuperación en producción hasta que exista esa entrega. El cookie de la app no se reenvía al gateway ni al juego.
