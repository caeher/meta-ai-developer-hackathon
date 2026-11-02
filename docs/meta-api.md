# Meta Model API

Estado de la revisión de fuentes: **2 de noviembre de 2026**. La conexión se configura solo en el servidor. La API oficial usa `https://api.meta.ai/v1` y el header `Authorization: Bearer ...`; este proyecto conserva el nombre requerido `META_API_KEY` y no lo expone con `NEXT_PUBLIC_`.

## Clave y modelos

1. Crea una clave en el [dashboard de Meta Model API](https://dev.meta.ai/).
2. Guárdala localmente como `META_API_KEY` en `.env.local`, o en el gestor de secretos del entorno desplegado. No la copies a GitHub, prompts, juegos, logs, issues ni respuestas HTTP. `.env.local` está excluido de Git.
3. Configura por separado `META_MODEL_PLAN`, `META_MODEL_CODE` y `META_MODEL_IMAGE`. Los defaults del proyecto son `muse-spark-1.3-contributor` para plan/código y `muse-image-1.0` para imagen. No existe una variante Contributor de imagen documentada.
4. `META_BASE_URL` debe ser exactamente el host oficial `https://api.meta.ai/v1`; no se aceptan hosts personalizados, HTTP, credenciales embebidas ni parámetros. `META_TIMEOUT_MS` debe estar entre 1.000 y 120.000 ms.

La documentación de Meta llama `MODEL_API_KEY` a la variable de sus ejemplos; el transporte de este proyecto toma `META_API_KEY` y añade el Bearer solo en el servidor. La lista `GET /v1/models` refleja qué modelos están disponibles para esa clave/equipo; el acceso depende de la cuenta, sus permisos de facturación y la disponibilidad aplicable. La ausencia de un modelo produce un error y no activa otro modelo como fallback.

## Smoke test

```sh
npm run meta:smoke
npm run meta:smoke -- --tools
npm run meta:smoke -- --image
npm run meta:smoke -- --tools --image
```

El comando carga `.env.local` y luego `.env` sin sobrescribir variables que ya estén en el proceso. Primero lista los modelos disponibles; después envía a `/v1/responses` una solicitud breve con texto sintético, `store: false`, razonamiento de nivel bajo y un máximo de 256 tokens. Valida el modelo devuelto, el estado completado, el texto y el ID de respuesta. No imprime headers ni bodies de error. Sin clave termina antes de hacer red; 401/403, 404, 429, timeout, JSON/schema inválidos y errores de red terminan con código distinto de cero y mensajes saneados.

`--tools` pide una función sintética `smoke_ping`, valida sus argumentos y devuelve un resultado fijo; puede hacer hasta dos solicitudes facturables por tokens. `--image` solicita una sola imagen sintética usando `muse-image-1.0`, valida que haya un resultado base64 acotado y lo descarta sin guardarlo. La generación de imagen puede tener un cargo separado. Consulta los [precios y límites actuales](https://dev.meta.ai/docs/pricing-rate-limits) antes de ejecutar esas opciones; los precios no se fijan en el código.

Las pruebas automáticas usan respuestas mock y no prueban acceso externo ni generan cargos. El smoke normal sí requiere una clave válida y hace una llamada de texto; el modo imagen es un opt-in explícito.

Verificación local del 2 de noviembre de 2026: `npm run meta:smoke` completó en Node 24.22.1; los modelos configurados estuvieron disponibles y la respuesta sintética incluyó texto y un ID de respuesta. La clave y el ID completo no se almacenaron. Las opciones `--tools` y `--image` no se ejecutaron.

## Contributor y datos

Meta indica que el contenido enviado mediante Contributor puede utilizarse para entrenar modelos futuros. No enviar información personal, sensible o confidencial. El smoke solo envía datos sintéticos; el producto todavía no conecta mensajes del usuario con Meta y no debe hacerlo hasta disponer de avisos y filtros adecuados. Un filtro automático no puede garantizar que todo dato sensible quede detectado. No habilitar Standard automáticamente ante fallos.

## Contrato y fuentes oficiales

- [Quickstart](https://dev.meta.ai/docs/quickstart) y [referencia de API](https://dev.meta.ai/docs/api-reference): base URL, Bearer y recursos.
- [Models](https://dev.meta.ai/docs/models): `muse-spark-1.3-contributor`, `muse-image-1.0` y disponibilidad.
- [Responses API](https://dev.meta.ai/docs/protocols/responses): `POST /v1/responses`, estados y campos de salida.
- [Tool calling](https://dev.meta.ai/docs/tool-calling): formato plano de tools de Responses, `function_call` y respuesta ligada a `call_id`.
- [Generación de imagen](https://dev.meta.ai/docs/cookbook/image-generation-basics): `image_generation_call` y resultado base64.
- [Contributor mode](https://dev.meta.ai/help/policies-and-privacy/contributor-tier): restricciones sobre datos personales/confidenciales.
- [Precios y límites](https://dev.meta.ai/docs/pricing-rate-limits): tarifas y límites vigentes.
