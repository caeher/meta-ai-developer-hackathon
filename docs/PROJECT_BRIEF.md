# Brief del proyecto: plataforma tipo v0 para crear juegos 2D (Meta AI Developer Hackathon)

## Tu tarea (Codex)
1. Lee este brief completo. Investiga lo que necesites (Meta, seguridad de autenticación propia, Radix) antes de escribir.
2. Crea `AGENTS.md` en la raíz del repo: la guía permanente para cualquier agente de código que trabaje aquí (visión, arquitectura, stack, estructura de carpetas, comandos, convenciones, reglas de seguridad, cómo tomar issues en orden, definición de "terminado").
3. Revisa el estado con `gh auth status` y `gh repo view caeher/meta-ai-developer-hackathon`, y crea con `gh` las labels, milestones e issues necesarias para implementar el proyecto completo.
4. Haz commit de `AGENTS.md` y de este brief (`docs/PROJECT_BRIEF.md`) en `main` y haz push a `origin`.
5. Al terminar imprime un resumen: lista de issues creadas (número, título, URL) en el orden de ejecución.

Escribe AGENTS.md y las issues en español (identificadores y código en inglés).

## La idea
Una plataforma web tipo v0.dev, pero en lugar de crear páginas web, crea **juegos 2D**. Referencia visual: un layout de dos paneles como v0:
- **Izquierda:** chat con el agente. Además de texto libre, el usuario puede elegir opciones rápidas relacionadas con creación de juegos 2D (género: plataformas, shooter, puzzle, RPG top-down, etc.; estilo de arte; controles; mecánicas; pedir sprites/fondos; agregar niveles, enemigos, sonido...). El chat muestra el progreso del agente (plan, pasos, archivos tocados, verificación).
- **Derecha:** vista previa en vivo (iframe) del juego que se va creando, con barra tipo navegador (atrás/adelante/recargar/abrir en pestaña nueva), selector de versión ("Latest"), y botones como Publish/Share.
- Un header con el nombre del proyecto, avatar del usuario y acciones.

## Decisión actual del propietario: aplicación monolítica y aceptación local

La aplicación es un monolito de producto. No se utiliza VPS, staging remoto, servidor remoto, host Linux dedicado, DNS público ni TLS wildcard real. `infra/compose.yml` es el entorno interno único para desarrollo, staging y aceptación con Docker Desktop y motor Linux. Silo provee S3 local; el runtime sandbox, cuotas, egress, gateway, observabilidad y rollback que pidan las issues deben implementarse y validarse dentro de ese Compose. Preview y publicación usan `*.localhost` y TLS local autofirmado cuando haga falta. El despliegue público final queda a cargo del propietario y no bloquea el roadmap.

## Stack obligatorio
- **Node 24** (requisito permanente para todos los proyectos Node de Cristian). Fija `engines` y `.nvmrc`.
- **Frontend:** Next.js (App Router) + TypeScript, **Radix UI** (Radix Themes y/o Primitives) para todas las vistas, con un **tema Tokyo Night** (paleta oscura: fondo #1a1b26, superficie #24283b, texto #c0caf5, acentos azul #7aa2f7, morado #bb9af7, cian #7dcfff, verde #9ece6a, naranja #ff9e64, rojo #f7768e). Define tokens de tema centralizados.
- **Auth:** sistema propio de correo y contraseña, sesiones opacas persistidas en PostgreSQL, verificación y recuperación por correo, middleware de rutas protegidas y `userId` propio como identidad de owner.
- **IA:** **API de Meta para desarrolladores (dev.meta.ai)** para: (a) uso agéntico / tool calling, (b) planificación (el agente genera un plan antes de ejecutar), (c) **generación de imágenes** (sprites, tilesets, fondos, UI del juego). Usar los **modelos "Contributor"** de Meta para ahorrar tokens; el modelo debe ser configurable por variable de entorno, con un modelo por tarea (plan, código, imagen). No inventes endpoints: verifica la documentación oficial de dev.meta.ai y crea una capa adaptadora (`MetaClient`) aislada para que cambiar endpoints/modelos no toque el resto del código. La API key va en `META_API_KEY` (nunca en el repo; `.env.example` con placeholders).
- **Core de skills del agente:** https://github.com/gamedev-skills/awesome-gamedev-agent-skills — estudia el repo, decide qué skills se integran como núcleo (ej. motores/frameworks 2D, sprites, física, game loop, input, audio, testing) y cómo se cargan en el contexto del agente según la tarea (carga selectiva para ahorrar tokens). Documenta el mecanismo en AGENTS.md.
- Motor de juego por defecto para los juegos generados: elige uno ligero para web 2D (p. ej. Phaser 3 o similar) alineado con las skills del repo, justifica la elección.

## Arquitectura de ejecución (lo más delicado: seguridad multiusuario)
- Cada usuario tiene un **workspace aislado** donde el agente escribe, instala, compila y **corre** su juego, y obtiene una **URL de preview propia** que solo él puede ver.
- El Compose interno aloja los workspaces de muchos usuarios en Docker Desktop. Diseña el aislamiento de forma segura: un sandbox por usuario/proyecto (contenedor hijo rootless), usuario Unix sin privilegios, sistema de archivos separado, límites de CPU/RAM/disco/procesos/tiempo, sin acceso a red salvo allowlist (registro npm si hace falta), sin secretos de la plataforma dentro del sandbox, sin acceso al socket Docker desde juegos, sin montar el host.
- **Acceso a la preview:** reverse proxy/gateway local que enruta `https://<projectId>.preview.localhost` (o ruta firmada) al puerto interno del sandbox. Cada solicitud valida la sesión propia del dueño o un token firmado de corta duración ligado a `userId` + `projectId`. Otro usuario nunca debe poder acceder, adivinar ni enumerar URLs. Cabeceras de seguridad, iframe con `sandbox` adecuado, CSP, origen separado del de la app principal.
- **El agente** (orquestador en el backend) usa Meta API para planificar, luego ejecuta herramientas dentro del sandbox del usuario (escribir/leer archivos, correr comandos permitidos, instalar dependencias, iniciar dev server, capturar errores/logs, generar imágenes y guardarlas como assets), itera hasta que el juego corre, y avisa al frontend para recargar la preview. Streaming de eventos al chat (SSE o WebSocket).
- Persistencia: base de datos para usuarios/proyectos/mensajes/versiones (elige y justifica; p. ej. Postgres + Prisma/Drizzle), almacenamiento de assets y snapshots de versiones del juego.
- Límites de uso/cuotas por usuario, cola de trabajos, limpieza de sandboxes inactivos.
- Entorno local de desarrollo con Docker Compose.

## Requisitos de las issues
- Deben poder ejecutarse **secuencialmente**: numera en el título (`[01] ...`, `[02] ...`), cada issue declara sus dependencias ("Depende de: #N") y deja el repo en estado funcional.
- Cada issue debe ser detallada: contexto/objetivo, alcance (qué entra y qué no), tareas concretas en checklist, archivos/módulos esperados, variables de entorno, criterios de aceptación verificables, cómo probarla, y notas de seguridad cuando aplique.
- Usa labels (p. ej. `setup`, `frontend`, `backend`, `agent`, `sandbox`, `security`, `ai`, `auth`, `infra`, `docs`) y milestones por fase (p. ej. Fundaciones, Auth y UI, Agente y Meta API, Sandbox y Preview, Generación de juegos, Endurecimiento y Demo).
- Incluye una issue específica para configurar la API key de Meta y validar la conexión (con un script de smoke test), una para autenticación propia, una para el tema Tokyo Night con Radix, una de pruebas de seguridad del aislamiento (intentos de acceso cruzado entre usuarios, escape del sandbox, SSRF), y una final de demo para el hackathon (guion, juego de ejemplo, despliegue).
- No crees issues duplicadas si ya existen; revisa `gh issue list` primero.
