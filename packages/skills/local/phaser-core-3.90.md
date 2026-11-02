# Phaser 3.90: escenas y carga

Esta guía adapta la skill upstream de Phaser, que apunta a Phaser 4.2, al baseline fijado por Forja: `phaser@3.90.x`. Mantén la dependencia y la API de Phaser 3; no migres majors para resolver una tarea.

- Lee primero la versión fijada en `package.json` y el lockfile del juego. Usa esta guía solo para Phaser 3.90.
- Configura `Phaser.Game` con `Phaser.AUTO`, `width`, `height`, `parent`, `scene` y `scale` según la plantilla existente.
- Organiza cada escena con `init(data)`, `preload()`, `create(data)` y `update(time, delta)`. `preload` encola recursos; Phaser inicia `create` tras terminar la carga.
- Usa `this.load.image`, `this.load.spritesheet` y `this.load.audio` desde `preload`. Crea objetos con `this.add` después de cargar sus recursos.
- En 2D, configura cámaras con `this.cameras.main`; enlaza transiciones mediante `this.scene.start`, `launch`, `pause` y `resume`.
- Mantén el loop de gameplay en `Scene.update(time, delta)` y deja el avance de física a Phaser. No vuelvas a aplicar manualmente `delta` a velocidades que ya controla Arcade Physics.
- Verifica la API en la documentación oficial de Phaser 3.90: https://docs.phaser.io/api-documentation/3.90.0/class/scene y https://docs.phaser.io/phaser/concepts/scenes.

La guía upstream de Phaser 4 se conserva para auditoría y se carga solo si el manifest de proyecto declara Phaser 4. Para Phaser 3.90 se carga esta adaptación local.
