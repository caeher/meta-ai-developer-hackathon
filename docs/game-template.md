# Plantilla Phaser

La plantilla autocontenida vive en `packages/game-templates/phaser/`. Usa Phaser 3.90.0 exacto, TypeScript y Vite; `package-lock.json` es para instalar el proyecto plantilla fuera del monorepo. Phaser, Vite, TypeScript y Vitest tienen versiones fijadas. `.nvmrc` y `engines.node` requieren Node 24. La build produce archivos estáticos con rutas relativas y sourcemaps apagados.

## Presets

El query param `genre` acepta solo `platformer`, `puzzle`, `shooter` o `rpg`; cualquier otro valor selecciona `platformer`.

| Género | Objetivo y controles | Mecánica de colisión/estado |
| --- | --- | --- |
| `platformer` | Teclas/flechas para correr y espacio o botón táctil para saltar; recoger 3 cristales y llegar al portal. | Arcade Physics gestiona velocidad, gravedad, plataformas y solapes con guardián/objetos. Tres impactos llevan a derrota; `R` reinicia. |
| `puzzle` | Flechas o pad táctil mueve una ficha por casillas; recoger 3 cristales y abrir el portal con Acción. | Reducer TypeScript acota el tablero, bloquea muros y contabiliza trampas/vidas; victoria, derrota y reinicio explícitos. |
| `shooter` | Flechas mueven la nave; espacio o Acción dispara; destruir 5 drones. | Arcade Physics gestiona proyectiles, enemigos y solapes. Los drones avanzan; tres impactos llevan a derrota. |
| `rpg` | Flechas o pad táctil exploran; recoger 3 runas, llegar al portal y usar Acción. | Mapa top-down por casillas, muros y guardianes que restan vidas; victoria, derrota y reinicio explícitos. |

Todos los presets incluyen pausa, mute y reinicio. Los botones táctiles son HTML accesible; los controles de teclado son flechas/WASD, Acción con espacio/E, pausa con P, mute con M y reinicio con R. El mute cubre todos los tonos generados por Web Audio. El contexto de audio se crea/resume solo tras gesto del usuario, se crea una sola vez y el audio no bloquea el juego si el navegador lo impide.

## Assets, red y hooks

`public/assets/manifest.json` identifica cada SVG original, procedencia y licencia del proyecto. No se cargan assets externos ni fuentes remotas. Los efectos son tonos sintetizados desde código; no hay ficheros de audio de terceros. El build fija `base: "./"`, bundlea Phaser localmente y no genera sourcemaps. El servidor Vite enlaza en `0.0.0.0:4173`, usa puerto estricto y el proxy/gateway sigue siendo responsable de autenticación y aislamiento.

En modo Vite desarrollo, `window.__GAME_TEST__.getState()` es un getter de solo lectura con fase, posición, vidas, progreso, mute, pausa y carga de assets. Los datos devueltos son snapshots congelados; no hay setter, evaluación de comandos ni acceso al filesystem. La condición `import.meta.env.DEV` elimina el hook de la build estática. Playwright acciona teclado y botones reales; unit tests ejercitan los reducers de victoria/derrota/reinicio de los cuatro géneros.

## Comandos

Desde la raíz del monorepo:

```sh
npm ci --prefix packages/game-templates/phaser --ignore-scripts
npm --prefix packages/game-templates/phaser test
npm run build:game-template
npm run test:e2e:game-templates
```

`npm run dev:worker` y `RUNS_ENABLED` no son necesarios para compilar la plantilla localmente. Durante un run habilitado, el worker materializa el conjunto allowlisted en un workspace vacío con `writeFile`, instala dependencias exactas por el proxy npm autorizado y sin lifecycle scripts, ejecuta `npm test` y `npm run build`, y arranca Vite mediante `startDevServer`. Los resultados de instalación/verificación quedan en eventos durables; `preview.ready` se emite después del health check. `.meta-game-template.json` registra hash y estado: `installing` permite reanudar una siembra interrumpida y `ready` evita sobrescribir proyectos personalizados. Los workspaces no vacíos sin marcador se conservan. El código de juego se ejecuta dentro del sandbox, nunca en el proceso web/worker.

La suite local demuestra build, lógica, render, input, assets y Vite/HMR con navegador. Los tests del worker comprueban materialización, instalación, test/build, health check y recuperación con un sandbox simulado. `ESTADO: PARCIAL`: aún falta comprobar Docker, egress DNS, cuotas y HMR a través del gateway autenticado dentro del Compose local; mantener `SANDBOX_DRIVER=disabled` y `PREVIEW_GATEWAY_ENABLED=false` hasta pasar esas pruebas.

## Resultados de esta entrega

En Node 24.22.1: `npm ci --prefix packages/game-templates/phaser --ignore-scripts` terminó correctamente; `npm --prefix packages/game-templates/phaser test` pasó 11 pruebas; `npm test` pasó 166 pruebas y omitió 23 pruebas de integración condicionadas por servicios. `npm run lint`, `npm run typecheck`, `npm run build:worker`, `npm run build` y `npm run build:game-template` pasaron. `npm run test:e2e:game-templates` pasó 15 pruebas en Chromium, Firefox y WebKit, incluida la conexión WebSocket local de Vite. Vite muestra su aviso informativo de chunk Phaser de ~1.23 MB. Las 3 pruebas nuevas del bootstrap cubren el manifiesto allowlisted, el orden de instalación/verificación y la preservación/recuperación del workspace.

La imagen local de `infra/worker.Dockerfile` se construyó correctamente; el helper cargó los 25 archivos allowlisted desde el contenedor. Esto no acredita aún aislamiento del runtime. Docker Desktop 29.9.2 informa `cgroupfs`; el daemon rootless anidado no aplica cgroups. El preflight de cgroups/cuota/seccomp, la instalación vía proxy desde workspace aislado y HMR autenticado están pendientes de integrar en el Compose. Caddy local ya define rutas `*.localhost`, pero no se han validado con cookies de la app. No se afirma aislamiento real hasta que las pruebas Docker pasen.
