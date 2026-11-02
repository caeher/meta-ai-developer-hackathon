# Verificar juegos Phaser

- Mantén la lógica de reglas, movimiento y puntuación en funciones TypeScript puras cuando sea razonable; cubre esas funciones con Vitest.
- Prueba en navegador el ciclo de vida real: inicio del canvas, carga de assets, cambios de escena, interacción por teclado o touch, y ausencia de errores en consola y solicitudes fallidas.
- Usa Playwright para interacción con canvas y teclado. Si la lógica puede extraerse y probarse sin rasterizar, prefiere comprobar el estado observable a comparar una imagen completa.
- Espera explícitamente a que termine el preload y a que el canvas tenga dimensiones válidas antes de enviar controles.
- Comprueba rutas de assets y límites de cámara con fixtures locales. No descargues assets externos durante una prueba.
- Registra las verificaciones que sí se ejecutaron; una prueba de funciones no afirma que se haya validado el render, el audio o la interacción del navegador.
