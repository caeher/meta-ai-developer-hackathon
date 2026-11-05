# Video explicativo de la plataforma - Diseno

Fecha: 2026-11-04. Estado: aprobado por el propietario ("dale" a la propuesta por defecto).

## Intencion
Video de 60-120 s para la demo del hackathon que explica la plataforma tipo v0 para crear juegos 2D por chat: prompt -> plan visible -> agente con herramientas -> preview privada en vivo -> versiones -> Publish/Share.

## Formato (decisiones del diseno)
- Horizontal 1920x1080, 30 fps, ~90 s (2700 frames), Remotion 4 en `agentic-edition-studio/`.
- Idioma: espanol. Narracion hablada con voz sintetica local (la API de Meta configurada no ofrece audio; verificado en `packages/meta`: solo plan/codigo/imagen). Musica y SFX sintetizados por codigo (Python/numpy), sin archivos inventados.
- Imagenes de apoyo (fondo hero, sprite/personaje, textura) generadas con la API de Meta (`muse-image-1.0`, `POST /v1/responses` con tool `image_generation`, segun `packages/meta/src/responses.ts:114`).
- Interfaz real: capturas con BrowserOS neo de la app local en Compose (`http://localhost:3000`): sign-in, proyectos, editor de dos paneles con preview. Sin datos personales: cuenta sintetica local si hace falta.
- Tema visual Tokyo Night del producto: fondo #1a1b26, superficie #24283b, texto #c0caf5, azul #7aa2f7, morado #bb9af7, cian #7dcfff, verde #9ece6a.

## Guion por beats (~90 s)
1. 0-8 s Hook: "Describe un juego. Mira como se crea." + imagen Meta hero.
2. 8-22 s Problema/idea: plataforma tipo v0 para juegos 2D (captura proyectos).
3. 22-42 s Chat + opciones rapidas + plan visible (captura editor).
4. 42-62 s Agente trabajando: herramientas, archivos, verificacion (captura editor/SSE) + assets Meta.
5. 62-78 s Preview privada en vivo jugable (captura preview/juego Phaser).
6. 78-90 s Versiones + Publish/Share + cierre con logo/texto.

## No objetivos
- No afirmar audio generado por Meta. No mostrar credenciales ni datos reales. No publicar el video en linea.

## Verificacion
- Stills de beats clave en `_scratch/`, render MP4 final, ffprobe/analisis de duracion y frames en negro, voz sincronizada con beats.
