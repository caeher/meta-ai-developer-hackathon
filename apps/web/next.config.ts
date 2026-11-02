import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["@meta-game/config", "@meta-game/contracts", "@meta-game/db", "@meta-game/preview"],
};

export default nextConfig;
