# Video Plataforma Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MP4 1920x1080 30fps de 60-120 s que explica la plataforma, en `agentic-edition-studio/projects/261104-app-demo/renders/`.

**Architecture:** Remotion composition con un componente por beat, assets locales importados (capturas PNG, imagenes Meta PNG, voz MP3/WAV, musica WAV), timings en frames derivados de la duracion real de la voz.

**Tech Stack:** Remotion 4.0.464, React 19, Python 3.13 (TTS/sintesis), API Meta `muse-image-1.0`, BrowserOS neo screenshots.

**Spec:** `docs/superpowers/specs/2026-11-04-video-plataforma-design.md`

## Global Constraints
- 1920x1080, 30 fps, duracion final entre 1800 y 3600 frames.
- Sin secretos ni datos personales en frames; cuenta sintetica local.
- No afirmar que Meta genera audio: Meta solo imagenes (y texto si se usa); voz = TTS local, musica = sintesis local.
- Colores Tokyo Night exactos del spec.

## Review Focus
- Voz mas larga que el video: medir duracion del audio y ajustar frames antes de renderizar.
- Capturas con sesion/datos ajenos: usar cuenta sintetica y revisar cada PNG.
- Frames en negro por assets que no cargan: stills por beat antes del render completo.
- Imagen Meta con texto deformado: prompts sin texto en la imagen; el texto lo pone Remotion.
- Render sin ffmpeg/Chrome: verificar `npm run compositions` y un still antes del render largo.

---

### Task 1: Setup del estudio
**Files:** Modify: `agentic-edition-studio/package-lock.json` (via npm install)
- [ ] `npm install` en `agentic-edition-studio/`; verificar `npm run compositions` lista `Example`.
- [ ] Crear proyecto: `npm run new -- app-demo --width 1920 --height 1080 --fps 30 --frames 2700`; registrar en `src/Root.tsx`.

### Task 2: Capturas BrowserOS neo
**Files:** Create: `agentic-edition-studio/projects/261104-app-demo/assets/shot-*.png`
- [ ] Abrir `http://localhost:3000`, crear cuenta sintetica local si no hay sesion, capturar sign-in/proyectos/editor/preview en 1920x1080.
- [ ] Revisar cada PNG: sin emails reales ni tokens visibles.

### Task 3: Assets Meta + audio
**Files:** Create: `assets/meta-*.png`, `assets/voice.wav`, `assets/music.wav` en el proyecto
- [ ] Generar 3 imagenes con `muse-image-1.0` via `POST https://api.meta.ai/v1/responses` (payload de `packages/meta/src/responses.ts:114`), guardar PNG y prompt en PROJECT.md.
- [ ] Grabar voz ES del guion con TTS local; medir duracion; sintetizar musica chiptune WAV con numpy.
- [ ] Ajustar frames por beat a la duracion real de la voz.

### Task 4: Composicion Remotion
**Files:** Create: `projects/261104-app-demo/Video.tsx`, `PROJECT.md` con beat table
- [ ] Un componente por beat del spec, animacion solo con useCurrentFrame/interpolate/spring, capturas con zoom/pan suave, subtitulos sincronizados con la voz.
- [ ] Renderizar stills de 6 beats a `_scratch/` y corregir solapamientos.

### Task 5: Render y verificacion
**Files:** Create: `projects/261104-app-demo/renders/app-demo.mp4`
- [ ] `npm run render AppDemo projects/261104-app-demo/renders/app-demo.mp4`
- [ ] Verificar duracion 60-120 s, resolucion, pista de audio y ausencia de tramos en negro (muestreo de frames).
