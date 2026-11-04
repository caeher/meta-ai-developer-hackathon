# Corrección UI/UX del editor — Diseño (opción A)

Fecha: 2026-11-03. Aprobado por el propietario: opción A (corrección quirúrgica).

## Intent
Corregir los defectos visibles en la captura del editor sin cambiar contratos, comportamiento del agente ni flags.

## Defectos y arreglo
1. Preview colapsada: `.previewPane` no acota altura; `.preview` debe ocupar 100% del panel (stage 1fr real).
2. Toolbar de pestañas con overflow horizontal: 8 pestañas + "Opciones rápidas" no caben en 43%. Sin scrollbar visible: pestañas con scroll silencioso (scrollbar-width:none) y botón de opciones fijo (flex:none), nunca cortado.
3. Estado vacío sin guía: con 0 mensajes, mostrar 4 ejemplos clicables que rellenan el borrador (no envían).
4. Composer sobredimensionado: textarea rows=2, footer compacto.
5. Publish/Share mudos: `title` + nota visible junto a los botones cuando publishing está deshabilitado ("Sin build verificada: Publish y Share están desactivados.", oculta en <=900px donde queda el title de los botones), sin ocultar el estado honesto.
6. Preview "Conectando…" eterno: ya existe estado `disabled` cuando no hay origin; se respeta. No se simula conexión.

## Non-goals
Panel redimensionable, rediseño de auth/listado, cambios en contratos/SSE/preview protocol.

## Verificación
E2E editor-shell existente (overflow, regiones, tabs, publish/share disabled), lint, typecheck, unit tests, captura visual 1440px.
