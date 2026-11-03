# Presupuestos de rendimiento (#25)

## Qué se mide

`npm run test:performance` ejecuta una medición reproducible en Chromium headless, contra el shell/editor real y respuestas de API/preview fixture deterministas:

| Medición | Inicio y fin | Presupuesto |
| --- | --- | ---: |
| Shell interactivo | Navegación inicial a apertura del diálogo de opciones rápidas | ≤ 2.500 ms |
| TT-first-event | Envío del prompt a primer estado SSE visible (“Planificando”) | ≤ 1.000 ms |
| Arranque de preview | Apertura del editor con preview a canvas listo y estado “Lista” | ≤ 3.000 ms |
| Recarga de preview | Activación de recargar a nuevo documento/canvas listo | ≤ 2.500 ms |
| FPS fixture | Solicitudes de animación completadas durante una muestra de 1 s | ≥ 30 FPS |

Los umbrales son límites de regresión, no objetivos de latencia de Meta ni de los contenedores. La primera respuesta de Meta y el arranque de un sandbox real son variables y no se mezclan con estas mediciones sin una medición controlada aparte. El fixture de FPS mantiene un canvas y un loop `requestAnimationFrame`; la E2E Phaser separada comprueba carga de assets y controles reales del template.

## Perfil y resultado local

Registrar cada corrida aceptada con el sistema operativo, CPU, memoria disponible, Node, versión Playwright/Chromium, comandos y resultado de cada presupuesto. No comparar cifras entre máquinas o tipos de browser. Chromium es el único perfil numérico; Chromium, Firefox y WebKit sí corren la suite E2E funcional.

Perfil de aceptación del 2 de noviembre de 2026: Windows 11 Pro 10.0.26300, Intel Core i7-1185G7 (8 procesadores lógicos), 15,4 GiB RAM, Node 24.22.1, Playwright 1.64.1 y Chromium 156.0.8078.4. Comando: `npm run test:performance`.

Resultado medido (todos dentro del presupuesto): shell interactivo 515 ms (≤ 2.500 ms); TT-first-event 155 ms (≤ 1.000 ms); arranque de preview 559 ms (≤ 3.000 ms); recarga de preview 176 ms (≤ 2.500 ms); FPS del fixture 61 (≥ 30 FPS). La prueba informa estos valores como `PERFORMANCE_BASELINE`.

## Privacidad

Playwright desactiva screenshot, video y trace. Los valores numéricos salen en stdout como una única línea `PERFORMANCE_BASELINE`; no se adjuntan chats, prompts, cookies ni artefactos a CI.
