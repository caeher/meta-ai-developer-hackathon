import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El dev server corre en Docker Compose y la web se abre como
  // 127.0.0.1:3000, localhost:3000 o https://app.localhost. Sin esto Next
  // bloquea los recursos de desarrollo (HMR/cliente) para esos origenes,
  // React no hidrata y los formularios caen a un GET nativo que filtra
  // las credenciales en la URL.
  allowedDevOrigins: ["127.0.0.1", "localhost", "app.localhost"],
  devIndicators: false,
  transpilePackages: ["@meta-game/config", "@meta-game/contracts", "@meta-game/db", "@meta-game/preview", "@meta-game/storage"],
};

export default nextConfig;
