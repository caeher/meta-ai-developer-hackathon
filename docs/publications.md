# Builds estáticas públicas

Issue #22 implementa Publish/Share para proyectos privados con autenticación propia. Publicar genera un artefacto estático independiente de la preview privada; no expone el workspace, el servidor de desarrollo ni el bucket S3. El origen de publicaciones vive en un dominio registrable distinto al de la aplicación y la preview.

## Flujo

1. La API comprueba la sesión PostgreSQL, el ownership del proyecto, que la versión pertenezca al proyecto y que su estado sea `ready`. La acción del editor requiere confirmación explícita de visibilidad pública. No se aceptan identidades del body como identidad del usuario: la web las deriva de la sesión y las pasa al servicio interno autenticado.
2. La clave de idempotencia persiste el intento para que reintentos del navegador no creen publicaciones duplicadas. El worker reclama una lease con fencing, lee el snapshot privado y exige que la versión y todas sus verificaciones estén aprobadas.
3. El worker crea un proyecto interno temporal, lo materializa en el sandbox rootless, ejecuta `npm ci --ignore-scripts` mediante el proxy npm permitido y `npm run build`. Solo inspecciona `dist/`: rechaza rutas ocultas, tipos no permitidos, source maps, archivos sobre 8 MiB, builds sobre 32 MiB y más de 1.024 archivos. Requiere `index.html`, escanea contenido con patrones de secretos y registra tamaños, tipos y SHA-256 por archivo.
4. Los objetos se escriben como `published/<slug>/<path>` con creación condicional: la URL de una publicación nunca cambia de contenido. PostgreSQL registra la publicación solo después de verificar los objetos y el manifiesto. Un reconciliador retoma builds con leases vencidas y elimina workspaces internos antiguos.
5. El origen recibe solamente GET/HEAD. Valida Host y slug, consulta que el registro siga publicado, comprueba el hash del manifiesto y valida el SHA-256 del objeto antes de servirlo. Resuelve solo rutas enumeradas en el manifiesto; no construye URLs S3 a partir de datos del cliente. Los errores son `no-store`; los artefactos publicados llevan `max-age=60`.
6. Revocar actualiza primero el estado en PostgreSQL y después elimina el prefijo S3. Desde ese commit, nuevas solicitudes reciben 404. La caché pública tiene TTL máximo de 60 segundos; una copia ya descargada o guardada por un navegador no se puede retirar del dispositivo del visitante.

## Configuración

`PUBLISHING_ENABLED=false` se mantiene por defecto. La web, el worker y el origen validan la bandera; iniciar el worker con publicaciones activas exige `SANDBOX_DRIVER=rootless` y un controlador privado configurado. Para activar el perfil local:

```sh
npm run infra:config
npm run infra:up -- --publishing
```

El perfil incluye web, worker y origen. En el entorno local, `infra/env.example` usa Silo privado y credenciales compartidas únicamente para desarrollo; el script inicializa ambos buckets como privados. No reutilices esos permisos en producción.

En producción configura:

- Un host Linux dedicado con Docker rootless validado, cuotas de disco, cgroups v2 y políticas de red del sandbox. Docker Desktop no acredita este aislamiento.
- DNS wildcard y TLS para `*.<PUBLISH_BASE_DOMAIN>`, en un dominio registrable separado de la app y la preview. Configura el proxy Caddy con [publishing/Caddyfile.example](../infra/publishing/Caddyfile.example). No publiques directamente el endpoint ni permitas acceso anónimo al bucket.
- Un bucket privado dedicado. La credencial del worker necesita PutObject, HeadObject, ListBucket y DeleteObject en el prefijo de publicaciones; la del origen solo necesita GetObject. No entregues credenciales administrativas a web, worker u origen. Usa `PUBLISH_READ_DATABASE_URL` con un rol PostgreSQL de solo lectura para el origen.
- `PUBLISHING_ENABLED=true`, `PUBLISH_BASE_DOMAIN`, `PUBLISHING_ORIGIN_PORT`, credenciales de almacenamiento del worker/origen y la URL de lectura de PostgreSQL. Mantén tokens internos fuera de las respuestas del navegador.

La compilación se ejecuta con el sandbox existente y sus límites de recursos. La detección de secretos es una barrera de defensa adicional basada en patrones, no una prueba de que el contenido sea secreto-cero. Las builds son código público ejecutable: no publiques una versión que contenga información privada.

## Comprobación local y límites externos

`npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run build:worker` y `npm run build:publishing-origin` comprueban el código y fixtures offline. Las pruebas de integración PostgreSQL/S3 dependen de servicios de prueba dedicados; no deben apuntarse a producción. El E2E comprueba la interacción del editor con endpoints fixture.

Validación local del 2 de noviembre de 2026: `npm run test:integration` pasó con PostgreSQL, Redis y Silo locales. La suite crea bases y buckets temporales, comprueba la persistencia/ownership de publicaciones en PostgreSQL y escribe/lee/borra artefactos S3 mediante las rutas de worker y reader; el origen HTTP sirve GET/HEAD anónimos desde el manifiesto, niega `.env`, fuentes y mapas, y responde 404 después de revocar. Todos los recursos temporales se limpian. En esta comprobación ambos roles usaron la credencial root local, así que no valida permisos mínimos ni separación productiva.

La implementación local no demuestra todavía rootless Docker en el host Linux dedicado, permisos productivos separados, DNS/TLS wildcard, comportamiento de cachés reales ni revocación entre navegadores. Hasta completar esa validación, deja `PUBLISHING_ENABLED=false`.
