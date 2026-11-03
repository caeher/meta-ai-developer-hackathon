# ADR 0007: observabilidad y recuperacion local

- Estado: aceptado
- Fecha: 2026-11-03
- Issue: #26

## Contexto

La plataforma necesita diagnostico correlacionado entre web, worker, controlador y preview, ademas de un procedimiento probado para recuperar PostgreSQL y S3. El propietario eligio Compose local como unico entorno interno; no hay VPS, staging remoto, DNS ni host Linux dedicado.

## Decision

- Usar logs JSON con campos allowlisted, request IDs UUID y run IDs opacos; no registrar contenido, identidad ni credenciales.
- Mantener una lista cerrada de metricas y labels acotadas, con health endpoints internos y alertas operativas locales.
- Mantener exportacion OTLP de logs opcional y desactivada si no se configura destino.
- Hacer backups pausando escritores Compose, incluyendo dump PostgreSQL y los dos buckets Silo, cifrando cada archivo con AES-256-GCM y un keyring local.
- Restaurar solo a DB y buckets vacios; validar recuperacion mediante un simulacro con recursos desechables.
- No publicar puertos de metricas ni credenciales de backup en el host/repo.

## Consecuencias

El backup requiere espacio local y la custodia/rotacion de claves pertenece al operador. El simulacro comprueba recuperacion en Docker Desktop, pero no sustituye una copia cifrada independiente ni el servicio de alertas/paging que el operador pudiera conectar.
