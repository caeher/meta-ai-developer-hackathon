# ADR 0004: controlador privado y driver rootless

Estado: aceptado como mínimo de ejecución; despliegue real pendiente.

## Contexto

Los juegos y comandos son código no confiable. Ni Next ni el worker de confianza deben acceder directamente a Docker; cada proyecto necesita aislamiento de filesystem, usuario, red y recursos.

## Decisión

- Añadir `apps/sandbox-controller` como servicio Node separado y `packages/sandbox` como contrato, cliente worker, servicio y driver Docker Engine.
- Ejecutar el controlador como usuario Linux dedicado, con socket Unix del daemon rootless disponible únicamente para ese usuario. Worker autentica con Bearer; owner se obtiene del proyecto activo en PostgreSQL y queda sujeto a FK compuesta. Web y sandbox no reciben el token ni el socket.
- Crear una instancia y volumen local/tmpfs por proyecto, con UID interior único asignado por secuencia PostgreSQL. Desactivar toda red y publicar cero puertos. Aplicar rootfs read-only, seccomp por defecto, capabilities vacías, `no-new-privileges`, cgroups v2/systemd, límite de memoria/CPU/PIDs y timeout.
- Mantener apagado por defecto. El controller comprueba Docker rootless, cgroups v2, driver systemd y seccomp al iniciar; `sandbox:host-check` prueba las cuotas desde contenedores desechables antes del despliegue.
- Usar TTL persistido y reaper que reclama leases vencidas en Postgres. El workspace tmpfs es temporal; snapshots/recovery no se atribuyen hasta #21.

## Consecuencias y riesgos

El límite de tamaño del workspace es un filesystem tmpfs real, pero usa RAM y no es cuota de disco persistente; debe sustituirse por una cuota respaldada por disco si el producto exige persistencia o 2 GiB de disco. Rootless reduce privilegios pero comparte kernel; el endurecimiento posterior puede usar gVisor/microVM sin quitar ownership ni cuotas. Falta probar el driver en Linux dedicado, con la imagen final y los controladores delegados; Windows/Docker Desktop nunca cuenta como esa evidencia.

## Reversión

Deshabilitar y detener el servicio, respaldar Postgres y ejecutar `packages/db/migrations/0004_sandbox-runtime-uid_down.sql` solo en una base descartable. Borrar volúmenes únicamente por IDs/labels `com.meta-game.managed=true` después de confirmar que no existen sandboxes activos.
