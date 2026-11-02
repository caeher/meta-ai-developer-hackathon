# Meta Model API

Estado de la revisión de fuentes: **2 de noviembre de 2026**. La conexión se configura solo en el servidor. La API oficial usa `https://api.meta.ai/v1` y el header `Authorization: Bearer ...`; este proyecto conserva el nombre requerido `META_API_KEY` y no lo expone con `NEXT_PUBLIC_`.

## Clave y modelos

1. Crea una clave en el [dashboard de Meta Model API](https://dev.meta.ai/).
2. Guárdala localmente como `META_API_KEY` en `.env.local`, o en el gestor de secretos del entorno desplegado. No la copies a GitHub, prompts, juegos, logs, issues ni respuestas HTTP. `.env.local` está excluido de Git.
3. Configura por separado `META_MODEL_PLAN`, `META_MODEL_CODE` y `META_MODEL_IMAGE`. Los defaults del proyecto son `muse-spark-1.3-contributor` para plan/código y `muse-image-1.0` para imagen. No existe una variante Contributor de imagen documentada.
4. `META_BASE_URL` debe ser exactamente el host oficial `https://api.meta.ai/v1`; no se aceptan hosts personalizados, HTTP, credenciales embebidas ni parámetros. `META_TIMEOUT_MS` debe estar entre 1.000 y 120.000 ms.

La documentación de Meta llama `MODEL_API_KEY` a la variable de sus ejemplos; el transporte de este proyecto toma `META_API_KEY` y añade el Bearer solo en el servidor. La lista `GET /v1/models` refleja los modelos de API habilitados para el equipo de esa clave. El acceso requiere una clave válida y depende de la configuración y verificación de la cuenta, la facturación y la disponibilidad aplicable. La ausencia de un modelo produce un error y no activa otro modelo como fallback. El smoke valida los tres IDs configurados contra esa lista antes de enviar el prompt.

La disponibilidad geográfica puede cambiar y no está garantizada por la lista de modelos. La política oficial prohíbe el acceso desde territorios restringidos y, a la fecha de revisión, no permite ofrecer Muse Image a usuarios ubicados en India. Comprueba la [política geográfica vigente](https://dev.meta.ai/legal/geographic-use-policy); no intentes eludir controles regionales. La política puede cambiar por jurisdicción o modelo.

## Contributor, privacidad y elegibilidad

En Model API, `muse-spark-1.3-contributor` es la variante Contributor de Muse Spark 1.3. Contributor permite que Meta use prompts, código, archivos, contexto y respuestas para entrenar modelos futuros. No envíes información personal, sensible, secreta o confidencial; si el producto admite contenido de usuarios, los filtros y controles deben impedir casos incompatibles antes de llamar a Meta. Ningún filtro automático garantiza detectar todo dato sensible. El proyecto no cambia automáticamente a Standard ante errores: cualquier cambio de modelo debe ser explícito y revisado.

Contributor no está disponible para equipos con Zero Data Retention (ZDR). La gestión de cuenta puede requerir confirmar la identidad; los servicios solo pueden usarse donde Meta los haya habilitado. El operador debe comprobar en el dashboard y la política geográfica los permisos de cuenta, equipo y región antes de habilitar una integración. Los usuarios del servicio y de los productos integrados deben tener al menos 18 años; el producto no puede dirigirse a menores de 18 y debe mantener una política de privacidad que explique los datos recopilados, su uso y sus destinatarios. Estas condiciones aplican al servicio, aunque el smoke de esta etapa solo envíe texto sintético.

## Smoke test

```sh
npm run meta:smoke
npm run meta:smoke -- --tools
npm run meta:smoke -- --image
npm run meta:smoke -- --tools --image
```

El comando carga `.env.local` y luego `.env` sin sobrescribir variables que ya estén en el proceso. Primero lista los modelos disponibles; después envía a `/v1/responses` una solicitud breve con texto sintético, `store: false`, razonamiento de nivel bajo y un máximo de 256 tokens. Valida el modelo devuelto, el estado completado, el texto y el ID de respuesta. No imprime headers ni bodies de error. Sin clave termina antes de hacer red; 401/403, 404, 429, timeout, JSON/schema inválidos y errores de red terminan con código distinto de cero y mensajes saneados.

`--tools` pide una función sintética `smoke_ping`, valida sus argumentos y devuelve un resultado fijo; añade hasta dos solicitudes facturables por tokens al smoke de texto. `--image` solicita una sola imagen sintética usando `muse-image-1.0`, valida que haya un resultado base64 acotado y la descarta sin guardarla. A fecha **2 de noviembre de 2026**, Meta publica un precio de **USD 0,01 por imagen generada y devuelta**; las llamadas de texto se cobran por tokens (para Muse Spark 1.3 Contributor: USD 0,10 por millón de tokens de entrada y USD 0,20 por millón de tokens de salida). Estos importes pueden cambiar: consulta los [precios y límites actuales](https://dev.meta.ai/docs/pricing-rate-limits) antes de ejecutar las opciones. Las tarifas no se codifican como constantes del producto.

Las pruebas automáticas usan respuestas mock y no prueban acceso externo ni generan cargos. El smoke normal sí requiere una clave válida y hace una llamada de texto; el modo imagen es un opt-in explícito.

Verificación local del 2 de noviembre de 2026: `npm run meta:smoke` completó en Node 24.22.1; los modelos configurados estuvieron disponibles y la respuesta sintética incluyó texto y un ID de respuesta. La clave y el ID completo no se almacenaron. Las opciones `--tools` y `--image` no se ejecutaron.

## Estado de integración

### Contrato de `MetaClient` (issue #9)

`packages/meta` expone `MetaClient.plan`, `streamCode`, `generateImage` y `smokeTest`; sus contratos públicos están en `packages/contracts/src/meta.ts`. Plan devuelve `{ summary, steps }` mediante `text.format` con JSON Schema y valida el resultado de nuevo con Zod. Los límites actuales son 80 KiB de entrada del plan, 256 KiB para el prompt de código, 1 MiB por payload, 32 herramientas, 32 KiB por schema, 64 KiB por argumentos/resultado, 16 llamadas por response y 4 MiB de texto de código.

El entrypoint de `packages/meta`, la validación de `META_API_KEY` y el transporte incluyen el marcador `server-only`; el smoke se ejecuta con la condición Node `react-server`. No importar estos módulos desde un Client Component ni exponer la configuración de Meta en el navegador.

`streamCode` entrega deltas de texto mientras llegan. Mantiene cada delta de argumentos por `item_id` y espera `response.function_call_arguments.done`, `response.output_item.done` y `response.completed`; nunca entrega una llamada parcial para ejecución. Valida el JSON completo con el schema Zod asociado al nombre de herramienta y rechaza IDs repetidos, llamadas paralelas incompletas o metadata distinta entre eventos y el response final. El paquete no ejecuta las herramientas. `MetaClient.toolResult(callId, value)` serializa un resultado de hasta 64 KiB; el input siguiente conserva el `tool_call` completo y empareja cada resultado por el mismo call ID.

El contexto usa el modo stateless documentado: cada request lleva `store: false` y solicita `reasoning.encrypted_content` solo para replay. `replay` incluye mensajes assistant visibles, llamadas completas y el bloque de razonamiento opaco cifrado; no incluye ni emite texto de razonamiento privado. Conservar replay solo dentro del contexto del run; el futuro worker debe filtrar datos sensibles antes de llamar a Meta y controlar el acceso a cualquier contexto persistido.

`generateImage` limita la respuesta base64 a 20 MiB, valida PNG/JPEG/WebP y dimensiones de hasta 8192 px por lado/40 MP, y devuelve bytes, MIME y dimensiones. El adaptador no guarda assets ni certifica que un sprite/tileset sea visualmente utilizable; eso se comprueba al integrar assets.

Los errores tienen códigos estables. 401, 403, 429, 5xx, cancelación, timeout, JSON/schema inválidos e imagen inválida se clasifican sin copiar bodies ni mensajes arbitrarios del proveedor. Se interpreta `Retry-After` como segundos o HTTP-date y `GET /models` reintenta como máximo dos veces con jitter. Ningún POST de plan/código/imagen se reintenta automáticamente porque Responses no documenta una clave idempotente para evitar cargos duplicados. Un timeout, una desconexión o un 5xx posterior al envío puede ser ambiguo; el caller debe reconciliar el run antes de iniciar otro. El worker durable y el fencing de #11 ya existen; Meta sigue desconectado hasta #16, por lo que la reconciliación de efectos ambiguos aún no tiene caller de producto.

El smoke solo envía datos sintéticos; el producto todavía no conecta mensajes de usuario con Meta ni ejecuta tool calls. La conexión real al chat queda deshabilitada hasta implementar avisos Contributor, elegibilidad y filtros de datos sensibles.

Las pruebas de esta capa son offline: `npm test -- tests/meta-client.test.ts tests/meta-smoke.test.ts`. El smoke real existente pertenece a la issue #8; no se requiere para las pruebas contractuales de #9 y `--tools`/`--image` siguen siendo opt-in facturables.

## Contrato y fuentes oficiales

- [Quickstart](https://dev.meta.ai/docs/quickstart) y [referencia de API](https://dev.meta.ai/docs/api-reference): base URL, Bearer y recursos.
- [Models](https://dev.meta.ai/docs/models): `muse-spark-1.3-contributor`, `muse-image-1.0` y disponibilidad.
- [Política geográfica](https://dev.meta.ai/legal/geographic-use-policy): habilitación por jurisdicción, territorios restringidos y disponibilidad de Muse Image.
- [Responses API](https://dev.meta.ai/docs/protocols/responses): `POST /v1/responses`, estados y campos de salida.
- [Structured output](https://dev.meta.ai/docs/structured-output): límites y modo estricto de JSON Schema.
- [Tool calling](https://dev.meta.ai/docs/tool-calling): formato plano de tools de Responses, `function_call` y respuesta ligada a `call_id`.
- [Generación de imagen](https://dev.meta.ai/docs/image-generation): `image_generation_call` y resultado base64.
- [Contributor mode](https://dev.meta.ai/help/policies-and-privacy/contributor-tier): uso de datos para entrenamiento, ZDR, privacidad, edad mínima y restricciones de datos.
- [Precios y límites](https://dev.meta.ai/docs/pricing-rate-limits): tarifas y límites vigentes.
