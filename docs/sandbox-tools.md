# Herramientas del sandbox

## API privada

El worker accede al controlador con Bearer; el controlador resuelve owner y proyecto en PostgreSQL antes de ejecutar operaciones. Las rutas base son `/v1/projects/{projectId}/sandbox/tools/`:

| Ruta | Método | Entrada y resultado |
| --- | --- | --- |
| `read-file` | POST | `{ path }`; texto UTF-8 de hasta 1 MiB |
| `write-file` | POST | `{ path, content }`; escritura atómica de hasta 1 MiB |
| `list-files` | POST | `{ path? }`; nombres, tipos y tamaños, hasta 32 entradas |
| `install-dependencies` | POST | Paquetes npm con nombre y versión SemVer exacta |
| `run-command` | POST | `npm --version`, `npm test` o `npm run <script>` |
| `start-dev-server` | POST | Levanta Vite en el puerto interno 4173 |
| `read-logs` | GET | Estado, lease y hasta 6 KiB de salida |

Las rutas no aceptan absolutos, `..`, barras inversas ni segmentos vacíos. El helper nativo usa descriptores de directorio con `openat` y `O_NOFOLLOW`, solo abre archivos regulares, escribe un temporal y publica con `renameat`. Cada comando usa argv sin shell, cwd bajo `/workspace`, timeout y salida acotada. Exceder el timeout detiene el contenedor. La instalación fuerza `--ignore-scripts`, caché efímera y registry interno; no acepta URLs, Git, tarballs ni comandos arbitrarios.

## Política de egress

Cada sandbox se conecta a su red privada `mg-sandbox-net-{sandboxId}` sin puertos publicados. Solo su proxy npm de confianza se conecta también a `mg-sandbox-egress`; el juego no comparte esa red. El sandbox apunta DNS a loopback y recibe un host estático para `npm-proxy`.

El proxy acepta GET/HEAD de rutas registradas, rechaza CONNECT, URLs completas, query strings, credenciales, puertos, hosts ajenos al allowlist y rutas fuera de metadata/tarball. Reescribe tarballs para volver a pasar por el proxy. Resuelve nombres allowlisted, rechaza toda respuesta IPv4 no pública, fija la conexión a una IP validada y conserva SNI/TLS para el hostname original. Los redirects pasan por las mismas comprobaciones y se limitan a tres saltos; IPv6 no se usa en conexiones upstream.

`SANDBOX_EGRESS_ALLOWLIST` contiene nombres DNS públicos exactos separados por comas, sin wildcard ni protocolo; máximo 16 e incluye `registry.npmjs.org`. Solo lo configura el operador. El driver inspecciona redes, labels y miembros, y falla cerrado si cambia la identidad del sandbox/proxy.

## Construcción y pruebas

La imagen se construye con `infra/sandbox/Dockerfile`, Node 24 y las dependencias fijadas. `SANDBOX_DRIVER=disabled` sigue siendo el valor por defecto.

Los tests offline de `tests/sandbox.test.ts` y `tests/security/` cubren schemas, rutas hostiles, comandos npm, ownership y políticas. `npm run test:security` agrega la matriz real de Compose con UID no root, aislamiento, egress, cuota tmpfs, cgroups, symlinks, lifecycle y timeout. La validación de #24 pasó en Docker Desktop; el modo de cuota por volumen/rootless y la integración del controlador de producto permanecen pendientes en sus issues, no se atribuyen a esta suite.