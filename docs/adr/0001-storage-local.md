# ADR 0001: storage S3 compatible para desarrollo local

- Estado: aceptado para desarrollo local.
- Fecha: 2026-11-02.

## Contexto

La arquitectura necesita un storage compatible con S3 en Compose. MinIO Community archivó su repositorio el 25 de abril de 2026; la publicación comunitaria de imágenes terminó. La imagen Docker Hardened de MinIO requiere un derecho de Extended Lifecycle Support.

## Decisión

Usar Postgres y Redis oficiales fijados por digest y **Silo**, fork compatible mantenido de MinIO, para el endpoint S3 local. Fijar tag y digest en `infra/compose.yml` y registrar referencias en `infra/images.lock.json`. Crear los buckets desde `infra:up` y negar acceso anónimo.

No agregar acceso a almacenamiento real, buckets públicos, credenciales del operador ni configuración de producción. Los puertos publicados enlazan a loopback. La red bridge es solo para estos servicios de desarrollo, no es una política de egress ni un sandbox.

## Consecuencias

- El desarrollo local sigue funcionando sin entitlement comercial de MinIO.
- Silo preserva la API S3 elegida y las interfaces de configuración `MINIO_*`, pero las pruebas futuras deben validar las operaciones reales usadas por la plataforma.
- Silo no es MinIO oficial. Antes de producción, seleccionar y revisar explícitamente el proveedor; no inferir mantenimiento, soporte contractual o conformidad de API completa.
- El repositorio archivado, la ausencia de imágenes comunitarias y los requisitos de ELS se documentan en [desarrollo local](../local-development.md).
