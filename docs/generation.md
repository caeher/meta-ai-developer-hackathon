# Generación, verificación y reparación (#20)

## Flujo

El worker convierte cada mensaje en un `GameSpec` Zod con género, intención, cambios y controles. Para una edición, prefiere la última especificación de una ejecución exitosa del mismo proyecto; valida esa preferencia antes de usarla y conserva el género si el usuario solo pide añadir contenido. Guarda el JSON en la plantilla Phaser 3.90.0 y lo incluye en el plan y en el contexto de código. Un workspace que ya tiene archivos se conserva; solo los workspaces vacíos reciben la plantilla confiable.

Antes de que el modelo escriba, el worker recorre el workspace y guarda un checkpoint comprimido en el bucket S3 privado con una ruta derivada de `ownerUserId`, `projectId` y `runId`. El checkpoint contiene archivos de texto elegibles hasta 256 archivos y 12 MiB; excluye cachés, dependencias, builds, rutas sensibles y archivos binarios. Rechaza la captura si detecta contenido que parece secreto o confidencial. La copia lleva checksum SHA-256 y se restaura ante error, cancelación o reparación agotada; después se elimina el checkpoint temporal. También se elimina tras una entrega verificada. Los assets generados usan rutas únicas; restaurar el manifest evita que un PNG nuevo reemplace el asset de la última versión válida.

La verificación ejecuta `npm test`, `npm run lint` y `npm run build` con comandos fijos del sandbox. Después exige el health check de Vite y ejecuta Chromium mediante un runner confiable instalado en la imagen del sandbox. El runner usa una sesión de navegador nueva, bloquea service workers y solicitudes fuera de `127.0.0.1:4173`, y comprueba el canvas, el preset, los controles visibles, movimiento por teclado y touch, objetivo, errores de consola y solicitudes bloqueadas. `preview.ready` se emite únicamente si todas esas comprobaciones pasan. Una falla permite un intento de reparación; si vuelve a fallar, el worker informa `verification_failed` y restaura el checkpoint.

Los resultados, logs y mensajes de consola son datos no confiables: se limitan, se redactan y se pasan al intento de reparación sin cambiar el conjunto de herramientas ni las reglas del sandbox. Las instalaciones npm del modelo se limitan a Phaser 3.90.0, Vite 7.3.7, TypeScript 5.9.3, Vitest 3.2.7 y `@types/node` 24.19.2; todas usan versiones exactas y `--ignore-scripts`.

## Validación

```sh
npm test -- --run tests/unit/generate-game.test.ts tests/unit/verify-game.test.ts tests/unit/orchestrator.test.ts tests/sandbox.test.ts tests/storage.test.ts
npm run build:game-template
npm run test:e2e:game-templates
npm run lint
npm run typecheck
npm run build
```

Playwright verifica los cuatro presets localmente sin depender de Meta. El recorrido del controller y el runner de Chromium tienen fixtures de contrato. En Node 24.22.1, la validación local previa reportó 197 pruebas aprobadas y 24 de integración omitidas; E2E pasó 21/21 en Chromium, Firefox y WebKit; lint, typecheck y builds web, worker y template Phaser pasaron.

El 2 de noviembre de 2026, `npm run meta:smoke` pasó con la configuración local de Meta. Ejecutó el listado de modelos y una respuesta de texto sintética; los IDs y el texto de respuesta se suprimieron de la salida. También se construyó `meta-game-sandbox:issue20-check` para `linux/amd64` con Docker Desktop y la sonda del runner pasó en un contenedor sin red, read-only y con Chromium. Esa imagen existe en el daemon local; publicarla no es un requisito de aceptación.

El preflight rootless no pasó: el contexto Docker Desktop `desktop-linux` informa `cgroupfs` y no tiene un controlador rootless configurado. No se ejecutó la generación inicial y edición con Meta dentro de un sandbox real. `ESTADO: PARCIAL`; el runtime sigue apagado con `RUNS_ENABLED=false`. Falta integrar el controlador al Compose local y pasar el recorrido con Silo/Redis/PostgreSQL; el despliegue público no forma parte del criterio.
El checkpoint temporal no crea versiones restaurables para el usuario; snapshots y selector de versiones pertenecen a #21. Assets binarios nuevos que queden sin referencia tras una reparación fallida requieren la limpieza de recursos de issues posteriores.
