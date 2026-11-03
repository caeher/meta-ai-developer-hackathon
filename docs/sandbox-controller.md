# Controlador y runtime de sandbox local

## Estado

`ESTADO: PARCIAL`. `packages/sandbox` y `apps/sandbox-controller` implementan el contrato privado, ownership por PostgreSQL y el driver Docker. La suite hostil #24 sí valida sandboxes reales no root y cuotas de tmpfs desde el perfil Compose `security`; el servicio del controlador y el driver rootless de producción todavía no forman parte del flujo Compose integrado. `SANDBOX_DRIVER=disabled` se mantiene por defecto.

La ejecución permanece cerrada por defecto. `SANDBOX_DRIVER=disabled` hasta que el preflight dentro del Compose local compruebe el runtime, cgroups, seccomp, red aislada, egress, filesystem y cuota efectiva. Si el motor ignora un límite, el controlador debe fallar antes de aceptar jobs.

## Contrato de seguridad

- El controlador deriva owner/proyecto de PostgreSQL y no acepta IDs de usuario del solicitante.
- Worker autentica con Bearer; web, worker y juegos no reciben el socket Docker. Solo el servicio de controlador local puede acceder al runtime.
- Los sandboxes usan UID no root único, rootfs read-only, `CapDrop=ALL`, `no-new-privileges`, seccomp, namespaces privados y cero puertos publicados.
- Cada sandbox tiene red privada; solo el proxy de confianza alcanza npm mediante el allowlist configurado. El juego no tiene egress directo.
- CPU, RAM, PIDs, disco, tamaño de archivos, output y timeout deben verificarse dentro de contenedores reales. Un mock no demuestra límites.
- Las leases y TTL viven en PostgreSQL. Un reaper elimina únicamente recursos etiquetados y conserva snapshots cuando los flujos de #21/#23 lo exigen.

## Imagen y herramientas

`infra/sandbox/Dockerfile` usa la versión Node fijada, compila `workspace-fs` y agrega el proxy egress y el verificador Playwright. La instalación npm acepta versiones exactas, usa `--ignore-scripts` y redirige al proxy. `runCommand` utiliza argv sin shell, cwd fijo y una allowlist de comandos.

El controlador devuelve errores cerrados si la imagen no coincide con la configuración, si cambia una label/red/volumen administrado o si no se cumplen los límites. No poner credenciales Meta, S3 ni de sesión en sandbox.

## Validación local requerida

La matriz de seguridad de #24 se ejecuta con `npm run test:security`: la suite offline y `tests/security/hostile-runtime.test.ts` corren desde el perfil Compose `security`, incluyendo `ENOSPC`, cgroups, rootfs, UID/capabilities, DNS/IPv4/IPv6, proxy npm, SSRF, symlinks, lifecycle scripts, timeout y dos sandboxes concurrentes. La aceptación de #24 pasó en Docker Desktop; eso no integra ni habilita aún el controlador de producto. El recorrido de integración usa:

```sh
npm run infra:config
npm run infra:up -- --web --worker
npm run test:integration
```

Ese comando valida Postgres, Redis, Silo, web y worker; el controlador no se presenta como servicio Compose activo.