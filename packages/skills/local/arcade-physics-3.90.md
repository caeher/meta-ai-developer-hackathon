# Phaser 3.90: Arcade Physics

Esta guía adapta la skill upstream de Arcade Physics, que apunta a Phaser 4.2, al baseline Phaser 3.90 del proyecto.

- Habilita Arcade en `GameConfig.physics`: `default: "arcade"` y `arcade: { gravity: { y: 500 }, debug: false }`.
- Usa `this.physics.add.sprite` para cuerpos dinámicos y `this.physics.add.staticGroup()` para plataformas fijas. Tras transformar un static body, llama `refreshBody()`.
- Registra `this.physics.add.collider(a, b, callback)` para colisiones y `this.physics.add.overlap(a, b, callback)` para sensores y recogibles. El mundo procesa esos colliders; no repitas las mismas comprobaciones en `update`.
- Controla movimiento con `body.setVelocity`, `setVelocityX`, `setAcceleration`, `setBounce`, `setCollideWorldBounds` y `setGravityY`, según la mecánica. Evita asignar la posición directamente a un cuerpo durante cada frame.
- Para control lateral, combina velocidad, gravedad y una decisión explícita de salto; usa `body.blocked.down` o `body.touching.down` con el collider para comprobar el suelo.
- Añade límites con `this.physics.world.setBounds` y `body.setCollideWorldBounds(true)`. Define callbacks pequeños y cambia estado de juego fuera de ellos si la operación es compleja.
- Confirma métodos y tipos en la documentación oficial Phaser 3.90: https://docs.phaser.io/phaser/concepts/physics/arcade y https://docs.phaser.io/api-documentation/3.90.0/class/physics-arcade-body.

No copies ejemplos de Phaser 4 a un juego 3.90. La fuente upstream se conserva y su hash se registra; esta adaptación local es el contenido que recibe el modelo para la versión fijada.
