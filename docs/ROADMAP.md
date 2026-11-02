# Orden de implementación

Estado local en `main`: la base del monorepo, servicios locales de Postgres/Redis/S3, persistencia multiusuario y tema Radix están implementados. El storage local usa Silo, fork compatible con MinIO, porque la distribución comunitaria de MinIO dejó de estar disponible. Las integraciones externas y capacidades futuras se declaran operativas solo tras su verificación.

Plan creado a partir de [PROJECT_BRIEF.md](PROJECT_BRIEF.md). Leer [AGENTS.md](../AGENTS.md) antes de tomar una issue. Cada issue depende de la anterior; sus cuerpos en GitHub contienen tareas, archivos, variables, aceptación, pruebas y seguridad. El estado actual está indicado en la fila de cada issue; no declarar capacidades posteriores disponibles sin implementarlas y verificarlas.

Estado de issue #4 actualizado el 2 de noviembre de 2026: la integración de Clerk, las rutas privadas, el contexto de owner y los fixtures de autorización ya están implementados. La issue sigue abierta hasta verificar sign-in, expiración y acceso cruzado con una instancia y dos usuarios Clerk de prueba; no hay credenciales de esa instancia configuradas en este entorno.

Estado de issue #5 actualizado el 2 de noviembre de 2026: tokens Tokyo Night, overrides de Radix, variables de Clerk, wrappers accesibles y galería local están implementados. La galería se revisó con Playwright Chromium en 390 y 1440 px; se guardaron capturas de la página y del diálogo en `docs/screenshots/`. El script `npm run screenshots:theme` comprueba contraste AA de tokens de texto, desbordamiento, foco de teclado, diálogo e hidratación. GitHub marca #5 como cerrada; la validación real de Clerk sigue pendiente en #4 y no bloquea el alcance visual.

Estado de issue #6: implementados CRUD paginado con ownership, transcript persistente e idempotente, dashboard, mensajes en texto plano y eliminación lógica con tarea durable de limpieza. La migración hace backfill ordenado de mensajes preexistentes. Los contratos e integración local son verificables con fixtures y PostgreSQL; la UI protegida requiere la instancia Clerk real, pendiente de la issue #4. No hay worker de limpieza, generación ni preview; quedan fuera de esta issue.

Estado local de issue #7 actualizado el 2 de noviembre de 2026: `/projects/[projectId]` usa el guard de sesión y la consulta con ownership ya implementados; presenta el editor responsive, permite renombrar, inserta opciones rápidas editables y guarda mensajes mediante el endpoint existente. Los contratos y vistas de plan/pasos/archivos/verificación están listos, sin datos de ejecución simulados. Preview, navegación, versiones, Publish y Share permanecen deshabilitados. `npm test` cubre las interacciones; `npm run test:integration` verifica la persistencia local. La issue #6 permanece abierta en GitHub aunque su alcance se describe implementado aquí; la autenticación real Clerk sigue pendiente en #4.

Estado de issue #8 (2 de noviembre de 2026): `npm run meta:smoke` pasó en Node 24.22.1 con una clave local de operador; `GET /models` mostró los IDs configurados para plan, código e imagen y `POST /responses` completó la respuesta sintética. No se guardaron la clave, headers, prompt completo ni el ID completo de respuesta. `npm test` valida errores offline con mocks; no se ejecutaron los opt-in facturables `--tools` ni `--image`. La verificación real no conecta todavía Meta al editor.

| Orden | Issue | Fase | Dependencia |
| --- | --- | --- | --- |
| 01 | [#1 [01] Inicializar el monorepo Next.js y fijar Node 24](https://github.com/caeher/meta-ai-developer-hackathon/issues/1) | Fundaciones | Ninguna |
| 02 | [#2 [02] Preparar Docker Compose y servicios de desarrollo](https://github.com/caeher/meta-ai-developer-hackathon/issues/2) | Fundaciones | #1 |
| 03 | [#3 [03] Modelar persistencia multiusuario y storage privado](https://github.com/caeher/meta-ai-developer-hackathon/issues/3) | Fundaciones | #2 |
| 04 | [#4 [04] Integrar Clerk y autorizar rutas y recursos por dueño](https://github.com/caeher/meta-ai-developer-hackathon/issues/4) | Auth y UI | #3 |
| 05 | [#5 [05] Crear el tema Tokyo Night con Radix y tokens accesibles](https://github.com/caeher/meta-ai-developer-hackathon/issues/5) | Auth y UI | #4 |
| 06 | [#6 [06] Implementar proyectos privados y persistencia del chat](https://github.com/caeher/meta-ai-developer-hackathon/issues/6) | Auth y UI | #5 |
| 07 | [#7 [07] Construir el editor de dos paneles y opciones rápidas](https://github.com/caeher/meta-ai-developer-hackathon/issues/7) | Auth y UI | #6 |
| 08 | [#8 [08] Configurar META_API_KEY y validar conexión con smoke test](https://github.com/caeher/meta-ai-developer-hackathon/issues/8) | Agente y Meta API | #7 |
| 09 | [#9 [09] Completar MetaClient para planes, tool calling e imágenes](https://github.com/caeher/meta-ai-developer-hackathon/issues/9) | Agente y Meta API | #8 |
| 10 | [#10 [10] Integrar skills de gamedev con carga selectiva y hashes](https://github.com/caeher/meta-ai-developer-hackathon/issues/10) | Agente y Meta API | #9 |
| 11 | [#11 [11] Crear cola durable, locks y reserva atómica de presupuestos](https://github.com/caeher/meta-ai-developer-hackathon/issues/11) | Sandbox y Preview | #10 |
| 12 | [#12 [12] Implementar sandbox rootless por usuario y proyecto en Linux](https://github.com/caeher/meta-ai-developer-hackathon/issues/12) | Sandbox y Preview | #11 |
| 13 | [#13 [13] Crear herramientas confinadas y política de egress e instalación](https://github.com/caeher/meta-ai-developer-hackathon/issues/13) | Sandbox y Preview | #12 |
| 14 | [#14 [14] Implementar gateway de preview privada y grants revocables](https://github.com/caeher/meta-ai-developer-hackathon/issues/14) | Sandbox y Preview | #13 |
| 15 | [#15 [15] Conectar iframe seguro y navegación de preview](https://github.com/caeher/meta-ai-developer-hackathon/issues/15) | Sandbox y Preview | #14 |
| 16 | [#16 [16] Implementar el orquestador con plan previo y herramientas acotadas](https://github.com/caeher/meta-ai-developer-hackathon/issues/16) | Generación de juegos | #15 |
| 17 | [#17 [17] Transmitir progreso por SSE y conectar el chat al agente](https://github.com/caeher/meta-ai-developer-hackathon/issues/17) | Generación de juegos | #16 |
| 18 | [#18 [18] Crear plantillas Phaser jugables y verificables por género](https://github.com/caeher/meta-ai-developer-hackathon/issues/18) | Generación de juegos | #17 |
| 19 | [#19 [19] Generar imágenes con Meta e integrar assets validados](https://github.com/caeher/meta-ai-developer-hackathon/issues/19) | Generación de juegos | #18 |
| 20 | [#20 [20] Completar generación y reparación hasta obtener un juego jugable](https://github.com/caeher/meta-ai-developer-hackathon/issues/20) | Generación de juegos | #19 |
| 21 | [#21 [21] Guardar snapshots y restaurar versiones inmutables](https://github.com/caeher/meta-ai-developer-hackathon/issues/21) | Generación de juegos | #20 |
| 22 | [#22 [22] Publicar y compartir únicamente builds estáticos verificados](https://github.com/caeher/meta-ai-developer-hackathon/issues/22) | Generación de juegos | #21 |
| 23 | [#23 [23] Completar cuotas, suspensión y limpieza recuperable de sandboxes](https://github.com/caeher/meta-ai-developer-hackathon/issues/23) | Endurecimiento y Demo | #22 |
| 24 | [#24 [24] Probar aislamiento multiusuario, escapes y SSRF con runtime real](https://github.com/caeher/meta-ai-developer-hackathon/issues/24) | Endurecimiento y Demo | #23 |
| 25 | [#25 [25] Validar recorridos E2E, accesibilidad y presupuestos de rendimiento](https://github.com/caeher/meta-ai-developer-hackathon/issues/25) | Endurecimiento y Demo | #24 |
| 26 | [#26 [26] Añadir observabilidad, recuperación y guías de operación](https://github.com/caeher/meta-ai-developer-hackathon/issues/26) | Endurecimiento y Demo | #25 |
| 27 | [#27 [27] Desplegar staging seguro y documentar operación y rollback](https://github.com/caeher/meta-ai-developer-hackathon/issues/27) | Endurecimiento y Demo | #26 |
| 28 | [#28 [28] Preparar y ensayar la demo final del Meta AI Developer Hackathon](https://github.com/caeher/meta-ai-developer-hackathon/issues/28) | Endurecimiento y Demo | #27 |

La excepción documentada de Meta es imagen con `muse-image-1.0`: no hay variante Contributor de imagen en las fuentes consultadas. Plan y código usan modelos Contributor configurables. No cerrar las issues de conexión, aislamiento o despliegue únicamente con fixtures.
