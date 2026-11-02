# Controlador de sandbox rootless

## Alcance y estado

La issue #12 introduce `packages/sandbox`, `apps/sandbox-controller`, persistencia del UID interior, un cliente privado para el worker y un driver Docker Engine que opera por socket Unix local. La API expone crear, inspeccionar, ejecutar argv sin shell, detener y destruir. No acepta owner IDs, URLs ni puertos del solicitante: el controlador resuelve el proyecto activo y su owner en PostgreSQL antes de tocar el runtime.

La implementación permanece cerrada por defecto. Para iniciar el servicio, el operador debe configurar `SANDBOX_DRIVER=rootless`, token aleatorio de al menos 32 bytes, URL PostgreSQL, imagen final por digest, socket del daemon rootless y límites. `verifyHost()` falla antes de escuchar si Docker no demuestra rootless, cgroups v2, driver systemd, seccomp y un backend de almacenamiento admitido. El listener queda solo en loopback; el ejemplo de Caddy añade TLS para el acceso del worker remoto. No se incluye el controlador en Compose y ningún contenedor de web/worker recibe `docker.sock`.

## Límites aplicados

- Un registro `sandboxes` único por `(ownerUserId, projectId)`, protegido por FK compuesta; los proyectos eliminados no se resuelven. El UID 10.000–59.999 sale de una secuencia única; al agotarse se falla cerrado.
- Nombres y labels deterministas del controlador; antes de operar, inspect valida el registro owner-proyecto, imagen, UID, límites, mount y opciones de seguridad. Las colisiones con recursos no administrados se rechazan.
- Rootless Docker, user namespace del daemon, usuario interior no root, rootfs read-only, `NetworkMode=none`, namespaces PID/IPC/cgroup privados, `CapDrop=ALL`, seccomp por defecto, `no-new-privileges`, sin dispositivos, bindings o mounts del host.
- RAM y swap limitadas a la misma cuota, CPU via `NanoCpus`, PIDs via cgroups v2 y capa de contenedor con `StorageOpt`. `/tmp` y `/run` son tmpfs con flags `noexec,nosuid,nodev`.
- Workspace separado por volumen local tmpfs nombrado con `size=SANDBOX_DISK_MB`, `noexec,nosuid,nodev`. El tamaño del filesystem impone `ENOSPC` efectivo, pero es efímero y RAM-backed; con RAM=1.024 MiB el límite de memoria puede alcanzarse antes de la capacidad nominal de 2.048 MiB. Si producto exige 2 GiB de disco persistente por workspace, hace falta provisionar cuotas de filesystem respaldadas por disco y verificar esa integración antes de declarar ese criterio completado.
- Timeout y exceso de salida terminan el contenedor para parar procesos residuales. El TTL se persiste en PostgreSQL; un reaper con `FOR UPDATE SKIP LOCKED` destruye sandboxes expirados y sus volúmenes.

La imagen `infra/sandbox/Dockerfile` exige `NODE_BASE_IMAGE` con referencia `@sha256:` al construirla; por ejemplo, pasa el digest aprobado mediante `docker build --build-arg NODE_BASE_IMAGE=<imagen-node-24>@sha256:<digest>`. El operador publica después la imagen resultante y fija también su digest en `SANDBOX_IMAGE`; `.env.example` solo contiene un placeholder. El controlador no instala paquetes ni interpreta scripts del proyecto; la allowlist de herramientas y la política de egress/npm son #13. Los datos de workspace no se consideran snapshots y se pierden al destruir el volumen; #21 agrega snapshots recuperables.

## Entorno de operación

El host debe ser Linux dedicado con Docker Engine rootless, cgroups v2 gestionados por systemd y controladores delegados. Consulta la [guía oficial de Docker rootless](https://docs.docker.com/engine/security/rootless/tips/) para habilitar las cuotas de CPU, memoria y PIDs. Docker documenta que las cuotas rootless de CPU/memoria/PIDs se ignoran si faltan cgroups v2/systemd; normalmente se requieren controladores `cpu`, `memory` y `pids` delegados al usuario rootless. El proceso del controlador no debe tener credenciales de Meta, S3 o Clerk.

Ejemplo de instalación pendiente de adaptar a la distribución y cuenta:

1. Crear usuario Linux sin privilegios dedicado a Docker rootless y su rango `subuid`/`subgid`.
2. Instalar/configurar daemon rootless con socket Unix accesible solo a ese usuario; habilitar cgroup v2 y delegación systemd de `cpu`, `memory`, `pids`.
3. Publicar la imagen sandbox por digest y preparar `/etc/meta-game/sandbox-controller.env` con token aleatorio, credencial PostgreSQL de mínimo privilegio, socket y límites.
4. Instalar `infra/sandbox/sandbox-controller.service.example`; un único controlador activo reclama expiraciones en Postgres.
5. Configurar `infra/sandbox/Caddyfile.example` con TLS interno, bind a la IP privada y firewall que permita solo los workers.
6. Correr `npm run sandbox:host-check`; abortar el despliegue ante cualquier salida distinta de `sandbox_host_ready ...`.

El controlador requiere `DATABASE_URL`. En producción usa un rol DB restringido a leer `projects` y administrar únicamente `sandboxes`; evita reutilizar credenciales de Meta, S3 o Clerk. El secreto Bearer solo se provisiona en el controlador y worker, nunca web, juego, `.env.local`, fixtures o logs. El token se compara en tiempo constante; no hay CORS ni redirecciones de cliente.

## Prueba reproducible

Contrato, rutas HTTP y operaciones del service se prueban sin runtime con driver falso en `tests/sandbox.test.ts`; esos tests no prueban aislamiento. En host Linux descartable, con `SANDBOX_DRIVER=rootless` y `SANDBOX_IMAGE` digest real:

```sh
npm run sandbox:host-check
npm run db:migrate
npm run build:controller
npm run dev:controller
```

El host check corre contenedores desechables sin red para medir `memory.max`, `cpu.max`, `pids.max`, filesystem, `ENOSPC`, UID no root y rootfs de solo lectura; prueba memoria y PID hasta alcanzar el límite y siempre borra el volumen temporal. Debe repetirse dentro del runner Linux dedicado antes de habilitar runs de producto. No correr pruebas hostiles en un equipo personal ni en producción.

## Riesgo y pendiente externo

Rootless comparte kernel con el host y no equivale a gVisor/microVM. El controlador no se ejecutó en este entorno Windows/Docker Desktop: no prueba un Docker rootless Linux ni cgroups de producción. Quedan pendientes el host Linux dedicado, imagen digest publicada, token, URL TLS privada y credencial DB de mínimo privilegio; también la cuota de disco persistente si la capacidad de workspace no debe ser volátil. Hasta entonces `SANDBOX_DRIVER=disabled`, `RUNS_ENABLED=false` y la generación permanecen cerradas.
