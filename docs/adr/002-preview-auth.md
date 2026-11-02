# ADR #14: grants revocables y gateway de preview privada

Estado: aceptada para implementación; dominio wildcard, TLS y validación de navegador/host Linux pendientes.

## Contexto

Cada preview ejecuta código no confiable. Conocer el UUID de un proyecto o copiar una URL no puede dar acceso al juego, y el gateway no debe publicar puertos ni aceptar destinos internos del navegador. La autenticación Clerk pertenece a la aplicación; el juego no debe recibir sus cookies, tokens ni credenciales.

## Decisión

- La aplicación verifica Clerk y ownership con la consulta PostgreSQL de proyecto. Solo si el proyecto está activo y el sandbox informa el servidor Vite fijo `4173` listo y con lease vigente, `POST /api/projects/[projectId]/preview-grant` emite un JWT RS256 de un uso y 60 segundos. El `jti` es aleatorio; los claims incluyen `userId`, `projectId`, `aud`, `exp` y `epoch`, además de `iss`, `sub` e `iat`.
- La clave privada PKCS#8 RSA codificada en base64 existe únicamente en la aplicación web. `PREVIEW_TOKEN_PUBLIC_KEYS` contiene un mapa JSON de `kid` a claves SPKI públicas codificadas en base64; el gateway valida sin conocer la clave privada. Rotar significa publicar la clave nueva con un `kid` distinto y conservar las claves públicas anteriores mientras puedan existir grants firmados por ellas.
- El navegador intercambia el grant en el body JSON de `POST https://<projectId>.<PREVIEW_BASE_DOMAIN>/__session`, usando `credentials: include` y `Origin: APP_ORIGIN`. El token nunca va en URL. Redis ejecuta un script Lua que compara el epoch, consume `jti` con `SET NX` y crea la sesión opaca en una misma operación atómica.
- La cookie de sesión es `__Host-preview_session`: host-only, `Secure`, `HttpOnly`, `Path=/`, `SameSite=None; Partitioned`. No incluye `Domain`. Su TTL por defecto es 15 minutos y el cliente debe renovarla desde una acción autenticada de la aplicación. La respuesta del intercambio permite CORS solo al origen exacto de la app y requiere el `Origin` exacto.
- Para cada HTTP, asset y WebSocket, el gateway valida `Host` como UUID bajo el dominio configurado, lee cookie y sesión, comprueba epoch y expiración en Redis y resuelve owner, proyecto, lease y puerto fijo en PostgreSQL. Los fallos de acceso devuelven la misma respuesta `404 Preview unavailable`; las rutas rechazadas nunca llegan al runtime.
- La dirección upstream se deriva del `sandboxId` recuperado de PostgreSQL: `mg-egress-<sandboxId>:8080`. El gateway no acepta URL, hostname ni puerto del cliente. El proxy confiable de ese proyecto valida la ruta y reenvía únicamente al contenedor `mg-sandbox-<sandboxId>:4173`, dentro de su red privada. El navegador nunca conecta al puerto del sandbox.
- Redis publica cada cambio de epoch. Todas las instancias gateway suscritas cierran los WebSockets del proyecto con código 1008; además cada socket tiene un cierre al expirar su sesión. La eliminación de un proyecto incrementa el epoch antes de aplicar el borrado lógico; `DELETE` del endpoint de preview revoca las sesiones del proyecto.
- El gateway elimina `Cookie`, `Authorization`, `Referer`, cabeceras Clerk y cabeceras `X-Forwarded-*` del salto al juego. Solo retransmite cabeceras de contenido necesarias; descarta `Set-Cookie` y CSP del upstream. Aplica `private, no-store`, `no-referrer`, `nosniff`, `frame-ancestors APP_ORIGIN`, CSP de preview, `Permissions-Policy` y límites de petición/rate.
- Caddy termina TLS con un certificado wildcard para `*.<PREVIEW_BASE_DOMAIN>` y reenvía el `Host` original. El gateway no publica puertos en Compose; solo se conecta a las redes privadas `control` y `mg-sandbox-egress`.

## Operación

`PREVIEW_GATEWAY_ENABLED=false` es el valor predeterminado. La app rechaza emitir grants y el gateway no inicia hasta que se habilite. Configure en el gestor de secretos la clave privada de la app, las claves públicas para app/gateway, `APP_ORIGIN`, el dominio y `PREVIEW_SESSION_TTL_SECONDS`. `PREVIEW_TOKEN_TTL_SECONDS` debe ser `60`. Para Compose local, `npm run infra:up -- --preview` requiere completar esos valores en `infra/.env`; el script prepara la red egress etiquetada. No registre los valores de claves ni el cuerpo de intercambio.

Consulte [Caddyfile.example](../../infra/caddy/Caddyfile.example) para TLS wildcard. El nombre `preview.example.test` es solo un placeholder; no resuelve públicamente ni dispone de certificado. La interfaz todavía no canjea el grant ni monta el iframe: pertenece a #15.

## Consecuencias y validación pendiente

Los tests offline cubren emisión, firmas inválidas y vencidas, replay, ownership cruzado, host/path hostiles, filtrado de credenciales, acceso HTTP, upgrade WebSocket y cierre por revocación. `tests/integration/preview-redis.test.ts` prueba los scripts Lua contra Redis real cuando se define `PREVIEW_TEST_REDIS_URL`.

Antes de habilitar una preview externa, el operador debe aportar claves Clerk de prueba, dominio wildcard con DNS/TLS y un host Linux dedicado con Docker rootless ya validado por #12/#13. También debe probar `SameSite=None; Partitioned` en los navegadores objetivo; este entorno no acredita una instancia real Clerk, TLS público, cookies de terceros ni acceso al host Linux dedicado. Mantener el feature flag apagado hasta completar esos pasos.

### Continuación de verificación (2 de noviembre de 2026)

En Node 24.22.1 pasaron `npm test` (124 tests; 22 omitidos), `npm run test:integration` (27 tests; 1 omitido), el test Redis ejecutado por separado contra el Redis local (1 test), `npm run lint`, `npm run typecheck`, `npm run build:gateway` y `npm run build`. La omisión del test Redis en la suite de integración se debe a que requiere `PREVIEW_TEST_REDIS_URL`; la ejecución separada confirmó consumo atómico y revocación con Redis real.

No se completó la validación externa: `infra/.env` no define `PREVIEW_BASE_DOMAIN` ni `APP_ORIGIN`, el gateway permanece desactivado y no hay certificado wildcard instalado. El Docker disponible usa el contexto `desktop-linux`; aunque reporta Linux y cgroups v2, no es el host dedicado y sus opciones de seguridad no acreditan Docker rootless. No se ejecutaron pruebas de host en Docker Desktop. Tampoco se realizó una comprobación en navegador real; por tanto, el comportamiento de `SameSite=None; Partitioned` en navegadores objetivo sigue pendiente.

La issue continúa abierta. Mantener `PREVIEW_GATEWAY_ENABLED=false` hasta validar DNS/TLS público, cookies en los navegadores objetivo y el host Linux dedicado.

## Reversión

Deshabilite `PREVIEW_GATEWAY_ENABLED`, detenga gateway y Caddy y revoque el epoch de cada proyecto. Retire la clave privada de la app y las claves públicas tras vencer grants anteriores. No borre la red `mg-sandbox-egress` ni recursos Docker administrados mientras existan sandboxes activos.
