# Shooter 2D cenital con Phaser 3.90

Esta guía cubre shooters 2D desde arriba en Phaser 3.90; no es una guía de FPS ni habilita otro motor.

- Usa una escena Phaser, `this.input` para controles y Arcade Physics para movimiento, proyectiles y overlaps.
- Separa el estado de armas (cadencia, cooldown y munición) del input. Limita la frecuencia de disparo con el reloj de escena o un evento temporizado.
- Reutiliza proyectiles mediante `Phaser.GameObjects.Group` con `maxSize` y `runChildUpdate` cuando haya suficientes instancias; devuelve cada proyectil al pool al salir de límites o impactar.
- Define el daño como una función de estado pequeña. En el callback de overlap, valida que ambos objetos sigan activos antes de aplicar daño y desactivar el proyectil.
- Apunta con coordenadas de mundo convertidas desde el puntero y actualiza la rotación del jugador con `Phaser.Math.Angle.Between`. Para mando, usa un vector analógico con deadzone.
- Mantén separadas las colisiones de enemigos, paredes y proyectiles; no permitas que un proyectil de jugador dañe al jugador.
- Verifica la API de colisiones en la documentación Phaser 3.90 de Arcade Physics. No cargues una skill de shooter FPS para un juego cenital.
