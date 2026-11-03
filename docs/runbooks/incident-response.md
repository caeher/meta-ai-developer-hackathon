# Runbook: diagnostico y rollback

## Primera comprobacion

```sh
npm run infra:config
docker compose -f infra/compose.yml --env-file infra/.env ps
curl http://localhost:3000/api/health/livez
curl http://localhost:3000/api/health/readyz
curl http://localhost:3000/api/metrics
```

`livez` comprueba el proceso; `readyz` comprueba dependencias. Si liveness pasa y readiness falla, revisa healthchecks de Postgres/Redis/Silo y codigo de evento; las respuestas no incluyen URL ni configuracion. Consulta eventos del worker con `docker compose ... logs worker` y correlaciona solo `requestId`/`runId` opacos.

## Casos operativos

- **Cola atascada:** confirma DB/Redis readiness, `queue_oldest_waiting_seconds`, `queue_stuck_jobs` y leases; inspecciona `run_lock_events_total`. Reinicia el worker solo cuando no esta detenido por un backup.
- **Errores Meta:** revisa `meta_requests_total`, latencia, codigos de error estables y si la solicitud es ambigua. No reintentes una solicitud facturable ambigua sin reconciliacion.
- **Disco:** `disk_used_ratio` mide el root filesystem visible al worker. Revisa volumenes y la carpeta local de backup; conserva retencion y nunca borres volumenes DB/S3 para resolver presion.
- **Preview denegada:** correlaciona el UUID de request y los labels de denegacion. Comprueba owner, lease, epoch y expiracion sin imprimir grant, cookie, Host privado o URL de sandbox.
- **Sweeper:** revisa `cleanup_runs_total`, runbook de lifecycle y el estado persistido antes de repetir la limpieza.

## Rollback

Deshabilita el flag del componente con fallo, vuelve al digest/configuracion local previamente aceptado y conserva PostgreSQL/Silo. Las migraciones son aditivas con reversa explicita. Para recuperar datos sigue [backup/restore](./backup-restore.md) y restaura primero a destinos vacios; no uses `infra:down --volumes` como rollback.

Los contenedores retienen un maximo de cinco archivos JSON de 10 MiB. El acceso a logs y metricas esta limitado al operador de Docker Desktop; los sandbox no tienen acceso al socket de Docker ni a endpoints de observabilidad.
