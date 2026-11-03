# Observabilidad interna de Compose

Compose no publica los puertos de metricas en el host. Web permanece ligado a `127.0.0.1:3000`; `/api/metrics` expone solo agregados de cardinalidad limitada. Worker, preview-gateway y publishing-origin escuchan en el puerto interno `OBSERVABILITY_PORT` (9090 por defecto) con `/livez`, `/readyz` y `/metrics`. El controlador tiene esos endpoints cuando se ejecuta con `SANDBOX_DRIVER=rootless`; no es parte de los perfiles web/worker, ya que el driver permanece `disabled` por defecto. PostgreSQL, Redis y Silo tienen healthchecks propios.

Las metricas de aplicacion cubren Meta (latencia, resultados, tokens, imagenes y coste estimado opcional), jobs y espera, run duration/locks, SSE, instancias sandbox por estado consultadas por el worker en PostgreSQL, operaciones sandbox, denegaciones de preview, limpieza y uso del filesystem visible al worker. Labels son enums cerrados; no usar IDs de owner/proyecto/run ni nombres arbitrarios.

Alertas del worker: espera >=900 s; disco >=85%; errores/ambiguos Meta >=20% con cinco o mas solicitudes en cinco minutos; y fallos de limpieza. Se evalua cada ciclo de reconciliacion de un segundo; logs de activacion/resolucion tienen el nombre fijo de la regla. Consulta `docker compose -f infra/compose.yml --env-file infra/.env logs worker`.

`LOG_LEVEL` controla nivel de salida. Cada servicio usa rotacion `json-file` de 10 MiB por archivo y cinco archivos. `OTEL_EXPORTER_OTLP_ENDPOINT` esta vacio por defecto y, si se configura, solo recibe logs JSON sanitizados. No se incluye collector externo en Compose ni dashboard con datos de usuario. El acceso a logs/metrics es para el operador local con acceso al Docker Desktop; las respuestas health son publicas pero solo dicen `ok`, `ready` o `not_ready`.

Thresholds y procedimiento operativo: [runbook de incidentes](../../docs/runbooks/incident-response.md) y [guia principal de operacion](../../docs/operations-issue-26.md).
