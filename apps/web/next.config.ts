import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@meta-game/config", "@meta-game/contracts"],
};

export default nextConfig;
