# Herramientas del sandbox

## API privada

El worker accede al controlador con Bearer y el controlador resuelve owner y proyecto en PostgreSQL antes de ejecutar cualquier operacion. Las rutas son relativas a `/v1/projects/{projectId}/sandbox/tools/`:

| Ruta | Metodo | Entrada y resultado |
| --- | --- | --- |
| `read-file` | POST | `{ path }`; texto UTF-8 de un archivo de hasta 1 MiB |
| `write-file` | POST | `{ path, content }`; escritura atomica limitada a 1 MiB |
| `list-files` | POST | `{ path? }`; nombres, tipos y tamanos de hasta 32 entradas |
| `install-dependencies` | POST | Paquetes npm con nombre y version SemVer exacta |
| `run-command` | POST | `npm --version`, `npm test` o `npm run <script>` |
| `start-dev-server` | POST | Sin entrada; levanta Vite en el puerto interno 4173 |
| `read-logs` | GET | Estado, lease y hasta 6 KiB de stdout/stderr |

Las rutas de archivos no aceptan absolutos, `..`, barras inversas ni segmentos vacios. `write-file` crea directorios padres faltantes de forma segura. El helper nativo mantiene descriptores de directorio abiertos con `openat` y `O_NOFOLLOW`, solo abre archivos regulares, escribe un temporal en el directorio destino y publica con `renameat`. Esto evita seguir symlinks y reemplaza el archivo final de forma atomica. Las entradas de directorio se limitan a 32 para que JSON permanezca dentro del limite de salida.

Cada comando usa argv sin shell, cwd fijado bajo `/workspace`, timeout configurable y salida combinada acotada a 64 KiB. Exceder el timeout detiene el contenedor entero, incluidos sus procesos hijos; la salida excesiva se trunca. `npm run` puede ejecutar el script del proyecto dentro del sandbox. La instalacion solo acepta nombres de paquete y versiones exactas, antepone `--ignore-scripts`, fija el cache efimero `/tmp/npm-cache`, no envia credenciales y fuerza el registry local. No acepta URLs, git, tarballs ni argumentos de instalacion libres.

Vite se inicia con una invocacion fija de `npm run dev -- --host 0.0.0.0 --port 4173`. El controlador registra estado y lease en PostgreSQL, espera HTTP 200 con `text/html` en loopback y solo devuelve el puerto fijo; el solicitante no elige host ni puerto. El reaper destruye el sandbox al vencer su lease. La preview privada y sus grants pertenecen a #14.

## Red y egress

El contenedor de codigo solo se conecta a `mg-sandbox-net-{sandboxId}`, una red bridge `internal` con IPv4/IPv6 y gateway mode `isolated`. Docker Engine 28 o posterior es requisito: una red `internal` por si sola puede seguir exponiendo servicios del gateway del host. El gateway `isolated` no crea una interfaz bridge en el host. Solo el sandbox y su proxy dedicado pertenecen a esa red, y no se publican puertos. El contenedor apunta DNS a loopback y recibe un hosts entry estatico para `npm-proxy`; la resolucion DNS directa de destinos externos debe fallar.

El proxy de confianza tambien esta conectado a `mg-sandbox-egress`, pero el codigo no. Solo acepta GET/HEAD a rutas npm registradas, rechaza CONNECT, URLs completas, query strings, credenciales, puertos, hosts que no esten en `SANDBOX_EGRESS_ALLOWLIST` y rutas fuera del metadata/tarball del paquete. Npm recibe un registry HTTP interno; el proxy reescribe los tarballs para que vuelvan a pasar por el mismo control.

Antes de abrir TLS, el proxy resuelve el nombre permitido, rechaza la solicitud si alguna respuesta IPv4 no es publica y fija la conexion a una IPv4 verificada, conservando SNI y validacion TLS para el hostname original. Cada redirect pasa por la misma allowlist y validacion, con un maximo de tres saltos. IPv6 no se usa para conexiones upstream. El contenedor de codigo no tiene ruta a redes externas, LAN, metadata ni IPv6 global; no depende solo de la lista de dominios.

`SANDBOX_EGRESS_ALLOWLIST` es una lista separada por comas de nombres DNS publicos exactos, sin wildcard ni protocolo, con maximo 16 nombres e incluye `registry.npmjs.org`. Solo la configura el operador. El driver inspecciona las redes y los containers antes de operar y falla cerrado si cambian sus labels, membresia, gateway o limites.

## Construccion y verificacion

Construye la imagen usando la base Node 24 fijada por digest en `infra/images.lock.json`; la imagen final tambien se configura en `SANDBOX_IMAGE` por digest. La imagen incluye `workspace-fs`, el proxy egress y el gestor de Vite. `SANDBOX_DRIVER=disabled` sigue siendo el valor por defecto.

Los tests offline cubren schemas, rutas hostiles, argumentos npm, rutas HTTP y el ciclo del service con driver falso. No acreditan aislamiento Linux. En un host Linux dedicado, despues de aprovisionar user quotas y publicar la imagen final, ejecuta:

```sh
npm run sandbox:host-check
npm run db:migrate
npm run build:controller
```

El host-check exige Docker rootless, Engine 28+, cgroups v2/systemd, seccomp y cuota de disco. El driver crea un sandbox desechable y prueba cuota `ENOSPC`, red DNS/IPv4/IPv6, acceso al proxy, traversal/symlink, instalacion npm con lifecycle malicioso ignorado, build, truncamiento de salida y timeout con destruccion de procesos. No ejecutes estos probes hostiles en un equipo personal o produccion. Windows/Docker Desktop no puede demostrar esta integracion; hasta verificar un host Linux dedicado, el driver sigue apagado.
