# ADR 0004: controlador privado y driver rootless

Estado: aceptado como mínimo de ejecución; host Linux dedicado pendiente de validación.

## Contexto

Los juegos y comandos son código no confiable. Ni Next ni el worker de confianza deben acceder directamente a Docker; cada proyecto necesita aislamiento de filesystem, usuario, red y recursos.

## Decisión

- Añadir `apps/sandbox-controller` como servicio Node separado y `packages/sandbox` como contrato, cliente worker, servicio y driver Docker Engine.
- Ejecutar el controlador como usuario Linux dedicado, con socket Unix del daemon rootless disponible únicamente para ese usuario. Worker autentica con Bearer; owner se obtiene del proyecto activo en PostgreSQL y queda sujeto a FK compuesta. Web y sandbox no reciben el token ni el socket.
- Crear una instancia y volumen local de Docker por proyecto, con UID interior único asignado por secuencia PostgreSQL. Configurar el filesystem de `DockerRootDir` como ext4/XFS con user quotas. Aplicar una cuota dura de disco al host UID que corresponde a cada UID interior; reservar UID 60.000 y una cuota de 16 MiB para el preflight.
- Conectar el codigo a una red bridge interna por proyecto, habilitar IPv4/IPv6 con gateway mode `isolated` de Docker Engine 28+ y publicar cero puertos. El modo internal aislado no crea un endpoint bridge en el host. Un sidecar proxy de confianza se conecta a la red privada y a la red egress; el sandbox solo llega a rutas npm autorizadas por ese proxy. Verificar DNS, IPv4/IPv6 privados y metadata desde codigo dentro del contenedor.
- Mantener apagado por defecto. El controller comprueba Docker rootless, cgroups v2, driver systemd, seccomp y crea un workspace de prueba para demostrar cuota de disco antes de escuchar. `sandbox:host-check` mide también RAM y PIDs en contenedores desechables.
- Usar TTL persistido y reaper que reclama leases vencidas en Postgres. Los datos del workspace existen mientras siga vivo el volumen; snapshots/recovery no se atribuyen hasta #21.

## Consecuencias y riesgos

Las cuotas de usuario viven en el filesystem dedicado de Docker root y se aplican a los host UIDs del rango `subuid` del daemon. Por eso ese filesystem debe tener user quotas habilitadas y no compartirse con otros servicios; el aprovisionador instala las cuotas del rango y el UID de prueba. El host-check Linux debe demostrar `ENOSPC`; Windows/Docker Desktop no sirve como evidencia. Rootless reduce privilegios pero comparte kernel; el endurecimiento posterior puede usar gVisor/microVM sin quitar ownership ni cuotas. La instalación real y el driver siguen pendientes de validación en un host Linux dedicado.

## Reversión

Deshabilitar y detener el servicio, respaldar Postgres y ejecutar `packages/db/migrations/0004_sandbox-runtime-uid_down.sql` solo en una base descartable. Borrar volúmenes únicamente por IDs/labels `com.meta-game.managed=true` después de confirmar que no existen sandboxes activos. Al retirar el servicio, quitar las cuotas de los UIDs reservados mediante el procedimiento operativo del filesystem.
