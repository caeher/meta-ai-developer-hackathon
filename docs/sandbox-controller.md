# Controlador de sandbox rootless

## Alcance y estado

La issue #12 introduce `packages/sandbox`, `apps/sandbox-controller`, persistencia del UID interior, un cliente privado para el worker y un driver Docker Engine por socket Unix local. La API ofrece crear, inspeccionar, ejecutar argv sin shell, detener y destruir. No acepta owner IDs, URLs ni puertos del solicitante: antes de tocar el runtime, el controlador resuelve en PostgreSQL el proyecto activo y su owner.

La ejecucion permanece cerrada por defecto. Para iniciar el servicio, el operador configura SANDBOX_DRIVER=rootless, un token aleatorio de al menos 32 bytes, URL PostgreSQL, imagen final por digest, socket de Docker Engine 28+ rootless, cuotas ya instaladas y limites. verifyHost() falla antes de escuchar si Docker no demuestra rootless, cgroups v2/systemd, seccomp, gateway aislado, cuota de disco, red y herramientas. El listener queda solo en loopback; el ejemplo Caddy anade TLS privado para el acceso remoto del worker. El controlador no esta en Compose y ningun contenedor web/worker recibe docker.sock.

## Límites aplicados

- Un registro `sandboxes` único por `(ownerUserId, projectId)`, protegido por FK compuesta; los proyectos eliminados no se resuelven. El UID 10.000–59.999 sale de una secuencia única; al agotarse se falla cerrado.
- Nombres y labels deterministas del controlador. Antes de operar, inspect valida owner-proyecto, imagen, UID, límites, volumen y opciones de seguridad. Las colisiones con recursos no administrados se rechazan.
- Rootless Docker 28+, user namespace del daemon, usuario interior no root, rootfs read-only, red bridge privada por proyecto con IPv4/IPv6 y gateway isolated, namespaces PID/IPC/cgroup privados, CapDrop=ALL, seccomp por defecto, no-new-privileges, sin dispositivos, bindings o mounts del host. Unicamente el proxy npm de confianza se conecta tambien a la red egress externa; el codigo no comparte esa red.
- CPU, RAM y swap se limitan con cgroups v2/systemd; PIDs con cgroups v2. `/tmp` y `/run` son tmpfs con `noexec,nosuid,nodev`; la capa raíz queda read-only.
- `/workspace` es un volumen local independiente, administrado por Docker en `DockerRootDir`, en un filesystem ext4/XFS con user quotas activas. El aprovisionador asigna una cuota dura de `SANDBOX_DISK_MB` al UID host que corresponde a cada UID interior 10.000–59.999. El UID 60.000 queda reservado para un volumen de prueba de 16 MiB; no lo asigna PostgreSQL. El archivo de imagen prepara `/workspace` como `root:root`, modo sticky `1777`, para que cada UID pueda escribir sin cambiar ownership; el root en Docker rootless mapea al usuario dedicado del daemon. Los archivos creados por el proceso quedan a nombre del UID único del sandbox y los límites producen `ENOSPC` en almacenamiento de disco.
- El contenedor no puede escribir fuera de `/workspace` salvo `/tmp` y `/run`, que tienen tmpfs acotado por RAM. La prueba de disco rechaza tmpfs y solo acepta volúmenes sobre ext4/XFS; no infiere el límite a partir de `statfs`.
- Timeout y exceso de salida detienen el contenedor para parar procesos residuales. El TTL se persiste en PostgreSQL; un reaper con `FOR UPDATE SKIP LOCKED` destruye sandboxes expirados y sus volúmenes.

## Preparar cuotas en Linux

El host dedicado debe usar un daemon Docker rootless con un rango `subuid`/`subgid` que mapee todos los UID interiores 10.000–60.000. Mantén `DockerRootDir` en un filesystem local ext4 o XFS dedicado y montado con `usrquota` (ext4) o `uquota`/`usrquota` (XFS). Activa user quotas con las herramientas de la distribución antes de aprovisionar; el script no cambia opciones de montaje ni habilita cuotas implícitamente.

Con acceso de root al host y al socket del daemon rootless, ejecuta:

```sh
sudo env \
  SANDBOX_DOCKER_SOCKET=/run/user/1001/docker.sock \
  SANDBOX_IMAGE='registry.example.internal/meta-game/sandbox-node24@sha256:<digest>' \
  SANDBOX_DISK_MB=2048 \
  bash scripts/provision-sandbox-user-quotas.sh
```

El script valida filesystem, cuotas activas y mapeo UID, comprueba que cada UID del rango se traduce a un host UID distinto y aplica cuotas duras en lote. El montaje debe ser dedicado a este daemon: las cuotas son de usuario sobre todo ese filesystem. Si cambia `SANDBOX_DISK_MB` o el mapeo `subuid`, vuelve a aprovisionar antes de reiniciar el controlador. No ejecutes el aprovisionador en una máquina personal ni en un filesystem compartido con datos ajenos al sandbox.

La imagen infra/sandbox/Dockerfile compila workspace-fs estatico y anade el proxy de egress y gestor de Vite; exige NODE_BASE_IMAGE fijada por digest al construirla. Publica la imagen resultante y configura su digest en SANDBOX_IMAGE. installDependencies acepta nombres npm y versiones SemVer exactas, fuerza el registry del proxy, desactiva lifecycle scripts y usa cache efimera sin credenciales; no acepta URLs, git, tarballs ni comandos de instalacion libres. runCommand admite solo npm --version, npm test o npm run <script> con argumentos acotados. La allowlist de herramientas y la politica de egress estan descritas en #13 y docs/sandbox-tools.md. Los datos del workspace se conservan mientras exista el volumen; los snapshots no se atribuyen hasta #21.

## Entorno de operación

El host debe ser Linux dedicado con Docker Engine rootless, cgroups v2 gestionados por systemd y controladores `cpu`, `memory` y `pids` delegados al usuario rootless. Consulta la [guía oficial de Docker rootless](https://docs.docker.com/engine/security/rootless/tips/) para los requisitos del daemon. El proceso del controlador no debe tener credenciales de Meta, S3 o Clerk.

Secuencia de instalación:

1. Crear usuario Linux dedicado a Docker rootless y reservarle rangos `subuid`/`subgid` sin solapamiento.
2. Habilitar cgroups v2 y delegar `cpu`, `memory` y `pids` a systemd para ese usuario.
3. Ubicar `DockerRootDir` en ext4/XFS local con user quotas habilitadas; usar un filesystem dedicado.
4. Construir y publicar la imagen de sandbox por digest; preparar las variables mínimas del controlador y la credencial PostgreSQL de mínimo privilegio.
5. Ejecutar `scripts/provision-sandbox-user-quotas.sh` como root para instalar las cuotas de UID del sandbox y la cuota de prueba.
6. Instalar `infra/sandbox/sandbox-controller.service.example`; un único controlador activo reclama expiraciones en Postgres.
7. Configurar `infra/sandbox/Caddyfile.example` con TLS interno, bind a la IP privada y firewall limitado a los workers.
8. Ejecutar npm run sandbox:host-check; exige Linux dedicado, Docker Engine 28+, IPv4/IPv6 aislados y completa probes de tools/egress antes de indicar sandbox_host_ready.

El controlador requiere `DATABASE_URL`. En producción usa un rol DB restringido a leer `projects` y administrar únicamente `sandboxes`; evita reutilizar credenciales de Meta, S3 o Clerk. El secreto Bearer solo se provisiona en el controlador y worker, nunca web, juego, `.env.local`, fixtures o logs. El token se compara en tiempo constante; no hay CORS ni redirecciones de cliente.

## Prueba reproducible

Contrato, rutas HTTP y operaciones del service se prueban sin runtime con driver falso en `tests/sandbox.test.ts`; esos tests no prueban aislamiento. En el host Linux desechable, después de aprovisionar cuotas y con `SANDBOX_DRIVER=rootless` e imagen digest real, ejecuta:

```sh
npm run sandbox:host-check
npm run db:migrate
npm run build:controller
npm run dev:controller
```

El preflight corre contenedores desechables y verifica cuotas, limites, rootfs read-only, red internal con gateway aislado, resolucion DNS externa denegada, acceso solo al proxy npm, destinos privados/metadata/IPv6 bloqueados, traversal/symlink, instalacion de paquete con lifecycle hook que debe fallar si se ejecuta, build fixture, salida truncada y timeout que destruye el contenedor y sus procesos. Estas pruebas requieren la imagen final y una red Docker rootless real; los tests de fixtures no las sustituyen.

## Riesgo y pendiente externo

Docker Engine 28+ se exige por el gateway isolated, que elimina el endpoint del bridge en el host; la red internal por si sola aun puede alcanzar servicios del gateway. El proxy egress resuelve hosts allowlisted, valida que todas las respuestas IPv4 sean publicas, fija la conexion TLS a una direccion validada, rechaza redirects fuera de allowlist y nunca permite CONNECT. Rootless comparte kernel

Referencias operativas: [Docker volumes](https://docs.docker.com/engine/storage/volumes/) y [`setquota(8)`](https://www.man7.org/linux/man-pages/man8/setquota.8.html).
