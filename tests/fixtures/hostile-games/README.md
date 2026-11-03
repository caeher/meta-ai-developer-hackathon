# Juegos hostiles de prueba

Estos payloads son sintéticos y solo se deben ejecutar dentro del sandbox desechable de `npm run test:security`. No contienen credenciales, no descargan código y escriben únicamente en `/tmp` del contenedor si se ejecuta un lifecycle hook. La expectativa es que `npm install --ignore-scripts` no cree ese marcador.
