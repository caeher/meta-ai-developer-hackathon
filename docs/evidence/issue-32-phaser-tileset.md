# Evidencia de aceptación #32

Fecha: 3 de noviembre de 2026.

`npm run infra:config` validó Compose y `npm run infra:up -- --web --worker --local-domains` dejó saludables Postgres, Redis, Silo, web, worker, Mailpit y el router local. `npm run test:assets:acceptance` pasó la suite de integración con PostgreSQL/Silo: 48 pruebas pasaron y una prueba de Redis preview quedó omitida por su flag específico. Después, Playwright Chromium pasó las tres previews de assets (#30, #31 y #32).

La integración de #32 subió cuatro frames PNG sintéticos de 16×16 al storage privado de Silo, ejecutó `create_tileset`, recuperó los dos objetos privados resultantes y verificó el manifest del workspace. El PNG final mide 32×32, conserva el orden `water`, `ground`, `wall`, `decoration`, y tiene SHA-256 igual en el resultado, storage y bytes escritos. La repetición del mismo `callId` devolvió el mismo resultado sin añadir otra entrada al manifest. El segundo owner no pudo empaquetar el source de la cuenta A.

La preview carga esos bytes recuperados de Silo en Phaser 3.90. Playwright comprobó índices locales 0–3, `firstgid` 1 y GIDs 1–4, color de píxel de cada tile, terreno por índice y colisiones locales 1 y 2. El tile `ground` se detectó como colisionable; el jugador cayó sobre la plataforma y se detuvo con el borde inferior en y=64 px. La captura de Chromium es [issue-32-phaser-tileset.png](issue-32-phaser-tileset.png).

En la misma aceptación, la preview de #31 comprobó frames y pivotes del atlas, la secuencia y frecuencia de animación, y el render/colisión de tiles. No hubo llamadas a Meta ni consumo de cuota; los píxeles fuente fueron sintéticos y pasaron por PostgreSQL/Silo reales.
