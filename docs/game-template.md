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

`npm run dev:worker` y `RUNS_ENABLED` no son necesarios para compilar la plantilla. El flujo de materializarla en un sandbox desde un run del agente pertenece a la integración posterior. Para verificarla con el servicio rootless real, copiar el contenido al workspace limpio, instalar dependencias exactas desde el proxy npm autorizado, ejecutar `npm test`, `npm run build` y arrancar el servidor fijo mediante las herramientas tipadas del controlador; nunca ejecutar el código de juego en el proceso web/worker.

La suite local puede demostrar build, lógica, render, input, assets y Vite/HMR de desarrollo con navegador. Fixtures y ejecuciones locales no acreditan Docker rootless, egress DNS, cuotas o el gateway con host/dominio reales. Esas verificaciones requieren el host Linux dedicado, Docker Engine 28+, el runtime y el dominio/TLS operativos; si no existen, mantener `SANDBOX_DRIVER=disabled` y `PREVIEW_GATEWAY_ENABLED=false`.

## Resultados de esta entrega

En Node 24.22.1: `npm ci --prefix packages/game-templates/phaser --ignore-scripts` terminó correctamente; `npm --prefix packages/game-templates/phaser test` pasó 11 pruebas; `npm test` pasó 163 con 23 omisiones de integración condicionadas por servicios. `npm run lint`, `npm run typecheck`, `npm run build` y `npm run build:game-template` pasaron. `npm run test:e2e:game-templates` pasó 15 pruebas en Chromium, Firefox y WebKit, incluida la conexión WebSocket local de Vite. Vite muestra su aviso informativo de chunk Phaser de ~1.23 MB.

El daemon accesible es Docker Desktop 29.9.2 en el contexto `desktop-linux`, no el controlador rootless del host Linux dedicado. El preflight real de cgroups/cuota/seccomp, la instalación vía proxy desde el workspace aislado, HMR a través del gateway autenticado, dominio/TLS y las cookies Clerk no se verificaron. No se ejecutaron pruebas hostiles ni se afirmó aislamiento real.
