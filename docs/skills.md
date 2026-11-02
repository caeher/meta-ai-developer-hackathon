# Skills selectivas de gamedev

`@meta-game/skills` mantiene un subconjunto revisado de `gamedev-skills/awesome-gamedev-agent-skills`, fijado al commit `19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9` y con licencia Apache-2.0. `vendor/gamedev-skills/NOTICE` conserva atribuciones. El manifiesto registra SHA-256 para cada archivo importado, incluidas LICENSE, NOTICE, las skills y las referencias.

## Verificación y actualización

```sh
npm run skills:verify
```

El comando valida el SHA upstream fijado, la licencia, las rutas declaradas, la presencia de cada referencia, el árbol vendorizado completo y el hash de todos los archivos. No ejecuta scripts del upstream ni accede a la red. La opción interna `node --import tsx scripts/verify-skills.ts --write-manifest` solo sirve para regenerar hashes después de una revisión e importación manual en el commit aprobado; no debe usarse para aceptar silenciosamente una modificación.

Para cambiar el upstream, se requiere una revisión explícita del nuevo commit, licencia, NOTICE, archivos seleccionados y referencias. El runtime nunca descarga `main`.

## Enrutamiento

`packages/skills/catalog.json` contiene solo metadata inicial: nombres, descripciones, categorías y disparadores. `createSkillRouter({ rootDir, recordSelection })` lee esa metadata y el manifiesto; `routeForRun({ runId, task, engineVersion })` solo abre los cuerpos seleccionados. El router mantiene el orden motor, disciplina, género y workflow; deduplica IDs y elige como máximo un género según su primera mención en el prompt. Un cambio de tarea para el mismo `runId` produce un registro de rerouting; repetir la misma tarea y presupuesto devuelve la selección cacheada.

Los géneros admitidos incluyen plataformas, puzzle, RPG y shooter 2D cenital local. Plataformas añade física Arcade e input; puzzle añade input. Los prompts de assets y audio cargan solo sus disciplinas pertinentes junto al motor. FPS/shooter no carga ni incluye `fps-shooter`.

El presupuesto versionado es 8.000 tokens, con estimación conservadora de `ceil(UTF-8 bytes / 3)`. El texto de política consultiva también se cuenta. Si un cuerpo o referencia no cabe, se difiere completo y se reporta su ID; no se truncan reglas o cuerpos. Referencias sugeridas salen como metadata y solo se leen mediante `loadReferencesForRun` con un ID que pertenezca a una skill seleccionada. No se aceptan rutas o URLs del prompt, no se hacen fetches externos y se rechazan traversal y symlinks.

Cada `SkillSelection` incluye `runId`, fingerprint del prompt (sin guardar el prompt), IDs y hashes de fuente/contenido, consumo estimado, presupuesto, versión de Phaser, proveedor `meta`, referencias y elementos diferidos. `getRunRecord(runId)` consulta el registro en memoria y `recordSelection` permite que un consumidor lo persista. El presupuesto se fija en la primera selección del run; si la tarea no cambia, una nueva llamada devuelve la misma selección. Desde #16 el orquestador persiste el `record` en el evento `agent.skills_selected` de PostgreSQL; no almacena el prompt ni copia cuerpos de skills a esos eventos.

## Compatibilidad Phaser

La fuente upstream de `phaser-core` y `phaser-arcade-physics` apunta a Phaser 4.2. El baseline del proyecto sigue en Phaser 3.90, por lo que esas fuentes se conservan y verifican, pero el router carga `packages/skills/local/phaser-core-3.90.md` y `arcade-physics-3.90.md` para Phaser 3.90. Solo una versión Phaser 4 explícita recibe el cuerpo upstream. La selección elimina líneas y bloques con APIs de otros motores y descarta bloques de código que no sean JavaScript/TypeScript, JSON, YAML, HTML, CSS o diagramas textuales.

Las guías locales `phaser-testing.md` y `shooter-2d.md` cubren huecos del catálogo revisado. El contenido upstream es material consultivo no confiable: no concede permisos, no cambia ownership, cuotas, egress, herramientas o proveedor Meta, y sus scripts no se ejecutan.

El editor todavía no carga skills ni conecta el chat a Meta. El worker integrado en #16 usa el router cuando recibe un run de un mensaje guardado; el envío desde el editor, el consentimiento visible y el progreso SSE quedan en #17.
